import {Texture} from './texture';
import {glStats} from './gl_stats';
import {type Context} from './context';
import {type Framebuffer} from './framebuffer';

export type PoolObject = {
    id: number;
    fbo: Framebuffer;
    texture: Texture;
    stamp: number;
    inUse: boolean;
    lastUsedFrame: number;
};
/**
 * @internal
 * `RenderPool` is a resource pool for textures and framebuffers
 */
/**
 * map2 fork: a holder of pre-allocated / preserved framebuffer+texture pairs (the
 * painter). Pool object creation measured 8–99ms EACH on Adreno — the dominant cost
 * of the first terrain frame — so objects are allocated ahead of time during idle 2D
 * and returned here on terrain uninstall instead of being destroyed.
 */
export type PoolObjectStash = {
    takePoolStash(size: number): {fbo: Framebuffer; texture: Texture} | null;
    stashPoolObject(size: number, fbo: Framebuffer, texture: Texture): boolean;
};

export class RenderPool {
    private _objects: PoolObject[];
    /**
     * An index array of recently used pool objects.
     * Items that are used recently are last in the array
     */
    private _recentlyUsed: number[];
    private _stamp: number;
    /**
     * One depth-stencil renderbuffer shared by every framebuffer in the pool: pool
     * framebuffers are only ever rendered to one at a time, and sharing halves the
     * pool's GPU memory — which is what bounds how many textures can stay cached.
     */
    private _sharedDepthStencil: WebGLRenderbuffer;

    private _frame: number = 0;

    constructor(
        private readonly _context: Context,
        private _size: number,
        private readonly _tileSize: number,
        private readonly _stash?: PoolObjectStash) {
        this._objects = [];
        this._recentlyUsed = [];
        this._stamp = 0;
    }

    /**
     * Mark a frame boundary. Eviction distinguishes objects used in the current
     * frame (backing entries that are certainly still needed) from objects idle
     * since an earlier frame (backing entries that may have left the working set).
     */
    public beginFrame() {
        this._frame++;
    }

    public destruct() {
        for (const obj of this._objects) {
            // map2 fork: keep the GPU resources for the next terrain install — every
            // 2D↔3D round trip otherwise re-pays the whole allocation burst
            if (this._stash?.stashPoolObject?.(this._tileSize, obj.fbo, obj.texture)) continue;
            obj.texture.destroy();
            obj.fbo.destroy();
        }
    }

    /**
     * Adjust the pool's capacity. The pool grows lazily on demand. An existing
     * over-capacity object population is kept (deleting objects would break the
     * id-based addressing of cached render-to-texture entries).
     */
    public setSize(size: number) {
        this._size = size;
    }

    public get size(): number {
        return this._size;
    }

    private _createObject(id: number): PoolObject {
        // map2 fork: time pool-object creation — the first terrain frame grows the pool
        // from zero to the whole working set (~40–60 framebuffer+texture pairs at
        // 4–16MB each), the remaining suspect for the ~330ms first-terrain stall on
        // Adreno now that compiles and uploads are instrumented and cleared.
        const allocStart = performance.now();
        // adopt a pre-allocated pair when available (idle-time prewarm / previous
        // terrain install) — attachment rewiring below is cheap; the allocation isn't
        const stashed = this._stash?.takePoolStash?.(this._tileSize);   // defensive: tests mock the painter
        let fbo: Framebuffer;
        let texture: Texture;
        if (stashed) {
            ({fbo, texture} = stashed);
        } else {
            fbo = this._context.createFramebuffer(this._tileSize, this._tileSize, true, true);
            texture = new Texture(this._context, {width: this._tileSize, height: this._tileSize, data: null}, this._context.gl.RGBA);
            texture.bind(this._context.gl.LINEAR, this._context.gl.CLAMP_TO_EDGE);
            if (this._context.extTextureFilterAnisotropic) {
                this._context.gl.texParameterf(this._context.gl.TEXTURE_2D, this._context.extTextureFilterAnisotropic.TEXTURE_MAX_ANISOTROPY_EXT, this._context.extTextureFilterAnisotropicMax);
            }
        }
        this._sharedDepthStencil ||= this._context.createRenderbuffer(this._context.gl.DEPTH_STENCIL, this._tileSize, this._tileSize);
        fbo.depthAttachment.set(this._sharedDepthStencil);
        fbo.colorAttachment.set(texture.texture);
        if (glStats.enabled) {
            const allocMs = performance.now() - allocStart;
            glStats.frame.poolAllocs++;
            glStats.frame.poolAllocMs += allocMs;
            if (allocMs > 8) {
                console.log(`[map2-fork] slow pool alloc: ${this._tileSize}px object ${id} ${allocMs.toFixed(1)}ms`);
            }
        }
        return {id, fbo, texture, stamp: -1, inUse: false, lastUsedFrame: -1};
    }

    public getObjectForId(id: number): PoolObject {
        return this._objects[id];
    }

    public useObject(obj: PoolObject) {
        obj.inUse = true;
        obj.lastUsedFrame = this._frame;
        this._recentlyUsed = this._recentlyUsed.filter(id => obj.id !== id);
        this._recentlyUsed.push(obj.id);
    }

    public stampObject(obj: PoolObject) {
        obj.stamp = ++this._stamp;
    }

    public getOrCreateFreeObject(): PoolObject {
        // Grow before reusing: every free object may back a render-to-texture cache
        // entry, and re-stamping one silently evicts that entry.
        if (this._objects.length < this._size) {
            const obj = this._createObject(this._objects.length);
            this._objects.push(obj);
            return obj;
        }
        // At capacity, first look for a free object idle since an earlier frame, in
        // LRU order. When capacity covers the working set, misses come from a trickle
        // of churn (new tiles, invalidations); an idle object backs an entry that
        // already fell out of the working set, so the replacement chain terminates.
        // Evicting the MRU here would sacrifice an entry rendered THIS frame — that
        // entry then misses and evicts another live one, and the wave saturates the
        // whole cache (observed as ~90% of stacks re-rendering every frame).
        for (let i = 0; i < this._recentlyUsed.length; i++) {
            const obj = this._objects[this._recentlyUsed[i]];
            if (!obj.inUse && obj.lastUsedFrame !== this._frame)
                return obj;
        }
        // Every free object was already used this frame: true over-subscription
        // (demand exceeds capacity). Evict the MOST recently used free object —
        // every cached entry is touched once per frame in a fixed order, so an LRU
        // victim is the entry that will be needed soonest and hit rate collapses to
        // zero. Sacrificing the most recently touched entry keeps a stable resident
        // set; only (demand - capacity) entries re-render per frame.
        for (let i = this._recentlyUsed.length - 1; i >= 0; i--) {
            const obj = this._objects[this._recentlyUsed[i]];
            if (!obj.inUse)
                return obj;
        }
        throw new Error('No free RenderPool available, call freeAllObjects() required!');
    }

    public freeObject(obj: PoolObject) {
        obj.inUse = false;
    }

    public freeAllObjects() {
        for (const obj of this._objects)
            this.freeObject(obj);
    }

    public isFull(): boolean {
        if (this._objects.length < this._size) {
            return false;
        }
        return this._objects.some(o => !o.inUse) === false;
    }
}
