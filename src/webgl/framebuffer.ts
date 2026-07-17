import {ColorAttachment, DepthAttachment, DepthStencilAttachment} from './value';

import type {Context} from './context';
import type {Texture} from './texture';
import {createFramebufferNotCompleteError} from '../util/framebuffer_error';

/**
 * @internal
 * A framebuffer holder object
 */
export class Framebuffer {
    context: Context;
    width: number;
    height: number;
    framebuffer: WebGLFramebuffer;
    colorAttachment: ColorAttachment;
    depthAttachment: DepthAttachment;

    /**
     * PATCH (map2-fork): optional owner of the colour attachment's texture. When the
     * attachment was created through the glMem-gauged Texture wrapper and the wrapper
     * isn't retained (and destroyed) anywhere else, park it here — destroy() then
     * routes through Texture.destroy so the resident-memory gauge decrements.
     * Deleting only the raw handle strands the wrapper's gauge bytes forever: the
     * prepared-hillshade fbos churning through a follow-cam run inflated `mem tex`
     * by ~300MB/min of phantom (the "6.6GB" reading on a healthy phone).
     */
    colorTexture: Texture | null = null;

    constructor(context: Context, width: number, height: number, hasDepth: boolean, hasStencil: boolean) {
        this.context = context;
        this.width = width;
        this.height = height;
        const gl = context.gl;
        const fbo = this.framebuffer = gl.createFramebuffer();

        this.colorAttachment = new ColorAttachment(context, fbo);
        if (hasDepth) {
            this.depthAttachment = hasStencil ? new DepthStencilAttachment(context, fbo) : new DepthAttachment(context, fbo);
        } else if (hasStencil) {
            throw new Error('Stencil cannot be set without depth');
        }
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
            throw createFramebufferNotCompleteError();
        }
    }

    destroy() {
        const gl = this.context.gl;

        if (this.colorTexture) {
            // Wrapper-owned attachment: Texture.destroy deletes the GL texture AND
            // decrements the glMem gauge (raw deleteTexture would skip the gauge).
            this.colorTexture.destroy();
            this.colorTexture = null;
        } else {
            const texture = this.colorAttachment.get();
            if (texture) gl.deleteTexture(texture);
        }

        if (this.depthAttachment) {
            const renderbuffer = this.depthAttachment.get();
            if (renderbuffer) gl.deleteRenderbuffer(renderbuffer);
        }

        gl.deleteFramebuffer(this.framebuffer);
    }
}
