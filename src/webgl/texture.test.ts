import {describe, expect, test, vi} from 'vitest';
import {Context} from './context';
import {Texture} from './texture';
import {glMem} from './gl_stats';
import {premultiplyAlpha, RGBAImage} from '../util/image';

describe('Texture', () => {
    describe('glPixelStore state is reset after texture creation', () => {
        const testImage = new RGBAImage({
            width: 2,
            height: 1,
        }, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

        function getContext(): Context {
            const gl = document.createElement('canvas').getContext('webgl') as WebGL2RenderingContext;
            return new Context(gl);
        }

        function checkPixelStoreState(context: Context): void {
            expect(context.pixelStoreUnpack.current).toEqual(context.pixelStoreUnpack.default);
            expect(context.pixelStoreUnpackFlipY.current).toEqual(context.pixelStoreUnpackFlipY.default);
            expect(context.pixelStoreUnpackPremultiplyAlpha.current).toEqual(context.pixelStoreUnpackPremultiplyAlpha.default);
        }

        test('premultiply=false', () => {
            const context = getContext();
            // We test the Texture constructor's side effects
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const _texture = new Texture(context, testImage, context.gl.RGBA, {premultiply: false});
            checkPixelStoreState(context);
        });

        test('premultiply=true', () => {
            const context = getContext();
            // We test the Texture constructor's side effects
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const _texture = new Texture(context, testImage, context.gl.RGBA, {premultiply: true});
            checkPixelStoreState(context);
        });
    });

    test('bind restores handle after corruption (#2811)', () => {
        const gl = document.createElement('canvas').getContext('webgl') as WebGL2RenderingContext;
        const context = new Context(gl);
        const image = new RGBAImage({width: 2, height: 1}, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
        const texture = new Texture(context, image, gl.RGBA);

        const originalHandle = texture.texture;
        texture.texture = gl.createTexture();

        texture.bind(gl.LINEAR, gl.CLAMP_TO_EDGE);
        expect(texture.texture).toBe(originalHandle);
    });

    test('premultiplyAlpha produces correct output', () => {
        // pixel: r=200, g=100, b=50, a=128 (half transparent)
        const data = new Uint8Array([200, 100, 50, 128]);
        const result = premultiplyAlpha(data);
        expect(result[0]).toBe(Math.round(200 * 128 / 255)); // 100
        expect(result[1]).toBe(Math.round(100 * 128 / 255)); // 50
        expect(result[2]).toBe(Math.round(50 * 128 / 255));  // 25
        expect(result[3]).toBe(128);
    });

    describe('map2-fork: glMem gauge and fbo-owned colour textures', () => {
        test('fbo.destroy() through colorTexture decrements the gauge', () => {
            // The prepared-hillshade pattern: a Texture wrapper backs the fbo colour
            // attachment and is not retained anywhere else. Without colorTexture,
            // fbo.destroy() deletes the raw handle and the wrapper's gauge bytes
            // leak forever (the "6.6GB mem tex" phantom).
            const gl = document.createElement('canvas').getContext('webgl') as WebGL2RenderingContext;
            vi.spyOn(gl, 'checkFramebufferStatus').mockReturnValue(gl.FRAMEBUFFER_COMPLETE);
            const context = new Context(gl);
            const baseBytes = glMem.texBytes;
            const baseCount = glMem.texCount;

            const texture = new Texture(context, {width: 4, height: 4, data: null}, gl.RGBA);
            expect(glMem.texBytes).toBe(baseBytes + 4 * 4 * 4);
            expect(glMem.texCount).toBe(baseCount + 1);

            const fbo = context.createFramebuffer(4, 4, false, false);
            fbo.colorAttachment.set(texture.texture);
            fbo.colorTexture = texture;
            fbo.destroy();

            expect(glMem.texBytes).toBe(baseBytes);
            expect(glMem.texCount).toBe(baseCount);
            expect(fbo.colorTexture).toBeNull();
        });

        test('double destroy stays gauge-neutral', () => {
            // Pool objects destroy texture then fbo; a colorTexture-owning fbo whose
            // wrapper was already destroyed must not decrement twice.
            const gl = document.createElement('canvas').getContext('webgl') as WebGL2RenderingContext;
            vi.spyOn(gl, 'checkFramebufferStatus').mockReturnValue(gl.FRAMEBUFFER_COMPLETE);
            const context = new Context(gl);
            const baseBytes = glMem.texBytes;

            const texture = new Texture(context, {width: 4, height: 4, data: null}, gl.RGBA);
            const fbo = context.createFramebuffer(4, 4, false, false);
            fbo.colorAttachment.set(texture.texture);
            fbo.colorTexture = texture;

            texture.destroy();
            expect(glMem.texBytes).toBe(baseBytes);
            fbo.destroy();
            expect(glMem.texBytes).toBe(baseBytes);
        });
    });
});
