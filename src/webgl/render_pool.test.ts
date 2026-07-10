import {describe, test, expect, vi} from 'vitest';
import {Context} from './context';
import {RenderPool} from './render_pool';

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
