
import type {StructArray} from '../util/struct_array';
import type {TriangleIndexArray, LineIndexArray, LineStripIndexArray} from '../data/index_array_type';
import type {Context} from './context';
import {glStats, glMem, currentBufferMemTag, addTaggedBufferBytes, removeTaggedBufferBytes,
    addOwnedBufferBytes, removeOwnedBufferBytes} from './gl_stats';

/**
 * @internal
 * an index buffer class
 */
export class IndexBuffer {
    context: Context;
    buffer: WebGLBuffer;
    dynamicDraw: boolean;

    // PATCH (map2-fork): resident-memory accounting (see glMem in gl_stats.ts)
    private _memBytes: number = 0;
    // Captured at construction, never re-derived — destroy() must credit the same bucket.
    private _memTag: string;
    // Likewise the owning tile's uid (0 = created outside a tile upload) — the leak probe.
    private _memOwner: number = 0;

    constructor(context: Context, array: TriangleIndexArray | LineIndexArray | LineStripIndexArray, dynamicDraw?: boolean) {
        this.context = context;
        const gl = context.gl;
        this.buffer = gl.createBuffer();
        this.dynamicDraw = Boolean(dynamicDraw);

        // The bound index buffer is part of vertex array object state. We don't want to
        // modify whatever VAO happens to be currently bound, so make sure the default
        // vertex array provided by the context is bound instead.
        this.context.unbindVAO();

        context.bindElementBuffer.set(this.buffer);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, array.arrayBuffer, this.dynamicDraw ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
        this._memBytes = array.arrayBuffer.byteLength;
        glMem.bufferBytes += this._memBytes;
        glMem.bufferCount++;
        this._memTag = currentBufferMemTag();
        addTaggedBufferBytes(this._memTag, this._memBytes);
        this._memOwner = addOwnedBufferBytes(this._memBytes);
        if (glStats.enabled) {
            glStats.frame.bufferUploads++;
            glStats.frame.bufferUploadBytes += array.arrayBuffer.byteLength;
        }

        if (!this.dynamicDraw) {
            array.freeBufferAfterUpload();
        }
    }

    bind() {
        this.context.bindElementBuffer.set(this.buffer);
    }

    updateData(array: StructArray) {
        const gl = this.context.gl;
        if (!this.dynamicDraw) throw new Error('Attempted to update data while not in dynamic mode.');
        // The right VAO will get this buffer re-bound later in VertexArrayObject.bind
        // See https://github.com/mapbox/mapbox-gl-js/issues/5620
        this.context.unbindVAO();
        this.bind();
        gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, array.arrayBuffer);
        if (glStats.enabled) {
            glStats.frame.bufferUploads++;
            glStats.frame.bufferUploadBytes += array.arrayBuffer.byteLength;
        }
    }

    destroy() {
        const gl = this.context.gl;
        if (this.buffer) {
            gl.deleteBuffer(this.buffer);
            delete this.buffer;
            // PATCH (map2-fork): resident accounting
            glMem.bufferBytes -= this._memBytes;
            glMem.bufferCount--;
            removeTaggedBufferBytes(this._memTag, this._memBytes);
            removeOwnedBufferBytes(this._memOwner, this._memBytes);
            this._memBytes = 0;
        }
    }
}
