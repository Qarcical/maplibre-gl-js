import {describe, test, expect, vi} from 'vitest';
import {Context} from './context';
import {RenderPool} from './render_pool';
import {Texture} from './texture';

describe('render pool', () => {
    const POOL_SIZE = 3;

    function createAndFillPool(): RenderPool {
        const gl = document.createElement('canvas').getContext('webgl');
        vi.spyOn(gl, 'checkFramebufferStatus').mockReturnValue(gl.FRAMEBUFFER_COMPLETE);
        const pool = new RenderPool(new Context(gl), POOL_SIZE, 512);
        for (let i = 0; i < POOL_SIZE; i++) {
            pool.useObject(pool.getOrCreateFreeObject());
        }
        return pool;
    }

    test('create pool should not be full', () =>  {
        const gl = document.createElement('canvas').getContext('webgl');
        const pool = new RenderPool(new Context(gl), POOL_SIZE, 512);
        expect(pool.isFull()).toBeFalsy();
    });

    test('create pool should be full', () =>  {
        const pool = createAndFillPool();
        expect(() => pool.getOrCreateFreeObject()).toThrow('No free RenderPool available, call freeAllObjects() required!');
    });

    test('create pool and fill it', () =>  {
        const pool = createAndFillPool();
        expect(pool.isFull()).toBeTruthy();
    });

    test('at capacity the most recently used free object is recycled', () =>  {
        const pool = createAndFillPool();
        pool.freeAllObjects();
        const obj0 = pool.getObjectForId(0);
        pool.useObject(obj0);
        pool.freeAllObjects();
        // recycling the most recently used free object keeps the resident set stable
        // when per-frame demand exceeds the pool's capacity
        const recycled = pool.getOrCreateFreeObject();
        expect(recycled.id).toBe(0);
    });

    test('at capacity an object idle since an earlier frame is recycled first, LRU order', () =>  {
        const pool = createAndFillPool();
        pool.freeAllObjects();
        // reuse objects 1 and 2 in the new frame; object 0 stays idle from the old frame
        pool.beginFrame();
        pool.useObject(pool.getObjectForId(1));
        pool.useObject(pool.getObjectForId(2));
        pool.freeAllObjects();
        // a churn miss must not evict an entry rendered this frame — the idle object
        // backs an entry that already fell out of the working set
        expect(pool.getOrCreateFreeObject().id).toBe(0);
    });

    test('falls back to MRU when every free object was used this frame', () =>  {
        const pool = createAndFillPool();
        pool.freeAllObjects();
        pool.beginFrame();
        for (let i = 0; i < POOL_SIZE; i++) {
            pool.useObject(pool.getObjectForId(i));
        }
        pool.freeAllObjects();
        // true over-subscription: sacrificing the most recently touched entry keeps
        // a stable resident set
        expect(pool.getOrCreateFreeObject().id).toBe(POOL_SIZE - 1);
    });

    test('not full after freeing an object', () =>  {
        const pool = createAndFillPool();
        const obj = pool.getObjectForId(0);
        pool.freeObject(obj);
        expect(pool.isFull()).toBeFalsy();
        expect(obj.stamp).toBe(-1);
    });

    test('stamp object should get stamped', () =>  {
        const pool = createAndFillPool();
        const obj = pool.getObjectForId(0);
        pool.stampObject(obj);
        expect(obj.stamp).toBe(1);
    });

    test('free all objects, most recently used object is recycled first', () =>  {
        const pool = createAndFillPool();
        pool.freeAllObjects();
        expect(pool.getOrCreateFreeObject().id).toBe(POOL_SIZE - 1);
    });

    test('destruct should remove textures', () =>  {
        const pool = createAndFillPool();
        pool.destruct();
        expect(pool.getObjectForId(0).texture.texture).toBeNull();
    });
});

// PATCH (map2-fork): shrink-to-demand — without it the pool population is grow-only
// and plateaus at the session's peak-ever demand (688MB measured on iPhone against a
// 20–55 object working set, riding under the iOS jetsam kill line).
describe('render pool shrink', () => {
    function createPool(size: number, stash?: any): RenderPool {
        const gl = document.createElement('canvas').getContext('webgl');
        vi.spyOn(gl, 'checkFramebufferStatus').mockReturnValue(gl.FRAMEBUFFER_COMPLETE);
        return new RenderPool(new Context(gl), size, 512, stash);
    }

    /** grow the pool to `count` used objects, then free them all */
    function grow(pool: RenderPool, count: number) {
        for (let i = 0; i < count; i++) {
            pool.useObject(pool.getOrCreateFreeObject());
        }
        pool.freeAllObjects();
    }

    /** advance the pool's frame counter without touching any object */
    function advanceFrames(pool: RenderPool, frames: number) {
        for (let i = 0; i < frames; i++) pool.beginFrame();
    }

    test('releases idle free objects down to target, LRU first', () => {
        const pool = createPool(6);
        grow(pool, 6);
        advanceFrames(pool, 10);
        // objects 4 and 5 are back in the working set; 0..3 stay idle
        pool.useObject(pool.getObjectForId(4));
        pool.useObject(pool.getObjectForId(5));
        pool.freeAllObjects();
        expect(pool.shrink(3, 5, 8)).toBe(3);
        // the three least-recently-used idle objects are gone, their slots tombstoned
        expect(pool.getObjectForId(0)).toBeNull();
        expect(pool.getObjectForId(1)).toBeNull();
        expect(pool.getObjectForId(2)).toBeNull();
        expect(pool.getObjectForId(3)).not.toBeNull();
        expect(pool.getObjectForId(4)).not.toBeNull();
        expect(pool.getObjectForId(5)).not.toBeNull();
    });

    test('never releases in-use or recently-used objects', () => {
        const pool = createPool(3);
        grow(pool, 3);
        pool.useObject(pool.getObjectForId(0));   // in use this frame
        // objects 1 and 2 are free but were used within the idle threshold
        expect(pool.shrink(0, 5, 8)).toBe(0);
    });

    test('respects the per-call release cap', () => {
        const pool = createPool(6);
        grow(pool, 6);
        advanceFrames(pool, 10);
        expect(pool.shrink(0, 5, 2)).toBe(2);
        expect(pool.shrink(0, 5, 2)).toBe(2);
    });

    test('released objects go to the stash; a re-grow reuses the tombstoned slot id', () => {
        const stashed = [];
        const stash = {
            takePoolStash(size: number) {
                const entry = stashed.pop();
                return entry ?? null;
            },
            stashPoolObject(size: number, fbo: any, texture: any) {
                stashed.push({fbo, texture});
                return true;
            }
        };
        const pool = createPool(3, stash);
        grow(pool, 3);
        advanceFrames(pool, 10);
        const releasedTexture = pool.getObjectForId(0).texture;
        expect(pool.shrink(2, 5, 8)).toBe(1);
        expect(stashed).toHaveLength(1);
        expect(pool.isFull()).toBeFalsy();
        // the grow adopts the stashed pair back and fills the tombstoned slot
        const regrown = pool.getOrCreateFreeObject();
        expect(regrown.id).toBe(0);
        expect(regrown.texture).toBe(releasedTexture);
        // a stale cache entry's old stamp can never match the fresh object
        expect(regrown.stamp).toBe(-1);
    });

    test('destroys released objects when the stash refuses them', () => {
        const stash = {
            takePoolStash: () => null,
            stashPoolObject: () => false,   // byte budget exhausted
        };
        const pool = createPool(2, stash);
        grow(pool, 2);
        advanceFrames(pool, 10);
        const texture = pool.getObjectForId(0).texture;
        const destroySpy = vi.spyOn(texture, 'destroy');
        expect(pool.shrink(1, 5, 8)).toBe(1);
        expect(destroySpy).toHaveBeenCalled();
    });

    // PATCH (map2-fork): Framebuffer.destroy deletes whatever renderbuffer is attached,
    // and pool fbos share ONE depth-stencil renderbuffer — a stash-refused shrink victim
    // used to delete it out from under the still-live pool, so the next grow attached a
    // deleted object (field-caught as INVALID_OPERATION mid-anim).
    test('shrink never deletes the shared depth-stencil; destruct deletes it exactly once', () => {
        const gl = document.createElement('canvas').getContext('webgl');
        vi.spyOn(gl, 'checkFramebufferStatus').mockReturnValue(gl.FRAMEBUFFER_COMPLETE);
        const deleteSpy = vi.spyOn(gl, 'deleteRenderbuffer');
        const stash = {takePoolStash: () => null, stashPoolObject: () => false};
        const pool = new RenderPool(new Context(gl), 3, 512, stash as any);
        grow(pool, 3);
        advanceFrames(pool, 10);
        expect(pool.shrink(1, 5, 8)).toBe(2);
        // the shared renderbuffer survives the destroyed victims...
        expect(deleteSpy).not.toHaveBeenCalled();
        // ...and a re-grow attaches it to a fresh fbo without touching a deleted object
        pool.getOrCreateFreeObject();
        // uninstall (stash still refusing → objects destroyed too) releases it exactly once
        pool.destruct();
        expect(deleteSpy).toHaveBeenCalledTimes(1);
    });
});

// PATCH (map2-fork): the pool adopts pre-allocated framebuffer+texture pairs from a
// stash (idle-time prewarm) and returns them on destruct (terrain uninstall) — pool
// allocation is 8–99ms per object on Adreno, the measured first-terrain-frame stall.
describe('render pool object stash', () => {
    test('destruct returns objects to the stash and a new pool adopts them', () => {
        const gl = document.createElement('canvas').getContext('webgl');
        vi.spyOn(gl, 'checkFramebufferStatus').mockReturnValue(gl.FRAMEBUFFER_COMPLETE);
        const context = new Context(gl);
        const stashed = [];
        const stash = {
            takePoolStash(size: number) {
                for (let i = 0; i < stashed.length; i++) {
                    if (stashed[i].size === size) {
                        const [entry] = stashed.splice(i, 1);
                        return entry;
                    }
                }
                return null;
            },
            stashPoolObject(size: number, fbo: any, texture: any) {
                stashed.push({size, fbo, texture});
                return true;
            }
        };

        // first install: allocates for real, uninstall stashes instead of destroying
        const poolA = new RenderPool(context, 4, 512, stash as any);
        const objA = poolA.getOrCreateFreeObject();
        const textureA = objA.texture;
        const destroySpy = vi.spyOn(textureA, 'destroy');
        poolA.destruct();
        expect(stashed).toHaveLength(1);
        expect(destroySpy).not.toHaveBeenCalled();

        // second install: adopts the stashed pair instead of allocating
        const poolB = new RenderPool(context, 4, 512, stash as any);
        const adopted = poolB.getOrCreateFreeObject();
        expect(adopted.texture).toBe(textureA);
        expect(stashed).toHaveLength(0);
        poolB.useObject(adopted);

        // stash empty: further growth allocates for real
        const second = poolB.getOrCreateFreeObject();
        expect(second.texture).not.toBe(textureA);
        poolB.useObject(second);

        poolB.destruct();
        expect(stashed).toHaveLength(2);
        expect(stashed.every(entry => entry.size === 512)).toBe(true);
    });
});
