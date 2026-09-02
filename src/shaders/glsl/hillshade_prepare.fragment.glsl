#ifdef GL_ES
precision highp float;
#endif

uniform sampler2D u_image;
in vec2 v_pos;


uniform vec2 u_dimension;
uniform float u_zoom;

float getElevation(vec2 coord, float bias) {
    // PATCH (map2-fork): u_image is a single-channel R32F texture holding METRES (see
    // color_relief.fragment.glsl) — read directly, no unpack.
    return texture(u_image, coord).r;
}

void main() {
    vec2 halfTexel = 0.5 / u_dimension;
    float tileSize = u_dimension.x - 2.0;

    // PATCH (map2-fork): node-centred 2x2 kernel. v_pos sits on the boundary between two
    // DEM texels in each axis, so taps at +/- half a texel land exactly on the four cell
    // centres around the node:
    // +---------+
    // | nw | ne |
    // +----o----+   o = v_pos (the node)
    // | sw | se |
    // +---------+
    // Every tap stays within one texel of the node, so a node ON a tile edge needs only
    // the 1px backfilled border ring — no wider DEM border is required.

    float nw = getElevation(v_pos + vec2(-halfTexel.x, -halfTexel.y), 0.0);
    float ne = getElevation(v_pos + vec2(halfTexel.x, -halfTexel.y), 0.0);
    float sw = getElevation(v_pos + vec2(-halfTexel.x, halfTexel.y), 0.0);
    float se = getElevation(v_pos + vec2(halfTexel.x, halfTexel.y), 0.0);

    // Here we divide the x and y slopes by 8 * pixel size
    // where pixel size (aka meters/pixel) is:
    // circumference of the world / (pixels per tile * number of tiles)
    // which is equivalent to: 8 * 40075016.6855785 / (tileSize * pow(2, u_zoom))
    // which can be reduced to: pow(2, 28.25619978527 - u_zoom) / tileSize.
    // We want to vertically exaggerate the hillshading because otherwise
    // it is barely noticeable at low zooms. To do this, we multiply this by
    // a scale factor that is a function of zooms below 15, which is an arbitrary
    // that corresponds to the max zoom level of Mapbox terrain-RGB tiles.
    // See nickidlugash's awesome breakdown for more info:
    // https://github.com/mapbox/mapbox-gl-js/pull/5286#discussion_r148419556

    float exaggerationFactor = u_zoom < 2.0 ? 0.4 : u_zoom < 4.5 ? 0.35 : 0.3;
    float exaggeration = u_zoom < 15.0 ? (u_zoom - 15.0) * exaggerationFactor : 0.0;

    // PATCH (map2-fork): x4 keeps the stored magnitude identical to the 3x3 Sobel this
    // replaces. The Sobel spanned two cells with weight 4 per side (8 * dz/dcell); the
    // 2x2 spans one cell with weight 2 per side (2 * dz/dcell).
    vec2 deriv = 4.0 * vec2(
        (ne + se) - (nw + sw),
        (sw + se) - (nw + ne)
    ) * tileSize / pow(2.0, exaggeration + (28.2562 - u_zoom));

    fragColor = clamp(vec4(
        deriv.x / 8.0 + 0.5,
        deriv.y / 8.0 + 0.5,
        1.0,
        1.0), 0.0, 1.0);

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
