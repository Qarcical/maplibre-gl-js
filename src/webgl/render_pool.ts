import {Texture} from './texture';
import {type Context} from './context';
import {type Framebuffer} from './framebuffer';

export type PoolObject = {
    id: number;
    fbo: Framebuffer;
    texture: Texture;
    stamp: number;
    inUse: boolean;
};
/**
 * @internal
 * `RenderPool` is a resource pool for textures and framebuffers
 */
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

    constructor(
        private readonly _context: Context,
        private _size: number,
        private readonly _tileSize: number) {
        this._objects = [];
        this._recentlyUsed = [];
        this._stamp = 0;
    }

    public destruct() {
        for (const obj of this._objects) {
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

    private _createObject(id: number): PoolObject {
        const fbo = this._context.createFramebuffer(this._tileSize, this._tileSize, true, true);
        const texture = new Texture(this._context, {width: this._tileSize, height: this._tileSize, data: null}, this._context.gl.RGBA);
        texture.bind(this._context.gl.LINEAR, this._context.gl.CLAMP_TO_EDGE);
        if (this._context.extTextureFilterAnisotropic) {
            this._context.gl.texParameterf(this._context.gl.TEXTURE_2D, this._context.extTextureFilterAnisotropic.TEXTURE_MAX_ANISOTROPY_EXT, this._context.extTextureFilterAnisotropicMax);
        }
        this._sharedDepthStencil ||= this._context.createRenderbuffer(this._context.gl.DEPTH_STENCIL, this._tileSize, this._tileSize);
        fbo.depthAttachment.set(this._sharedDepthStencil);
        fbo.colorAttachment.set(texture.texture);
        return {id, fbo, texture, stamp: -1, inUse: false};
    }

    public getObjectForId(id: number): PoolObject {
        return this._objects[id];
    }

    public useObject(obj: PoolObject) {
        obj.inUse = true;
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
        // At capacity, evict the MOST recently used free object. Every cached entry is
        // touched once per frame in a fixed order, so when demand exceeds capacity an
        // LRU victim is the entry that will be needed soonest — hit rate collapses to
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
