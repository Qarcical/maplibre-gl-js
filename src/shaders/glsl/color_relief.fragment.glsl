#ifdef GL_ES
precision highp float;
#endif

uniform sampler2D u_image;
uniform sampler2D u_elevation_stops;
uniform sampler2D u_color_stops;
uniform int u_color_ramp_size;
uniform float u_opacity;

// PATCH (map2-fork): cross-fade for raster-dem tile transitions — mix ELEVATIONS between
// this tile and its fading parent before the ramp lookup (metres are ring-independent, so
// the blend morphs the surface smoothly). u_fade_t mixes toward the parent; edge tiles
// with no parent self-fade via u_opacity in the uniform values instead.
uniform sampler2D u_image_parent;
uniform float u_fade_t;
in vec2 v_pos_parent;

in vec2 v_pos;

float getElevation(vec2 coord) {
    // PATCH (map2-fork): u_image is a single-channel R32F texture holding METRES, so hardware
    // bilinear interpolates linear heights — no unpack of filtered packed bytes (which corrupted
    // elevations, worst at 0 m where the terrarium carry byte flips).
    return texture(u_image, coord).r;
}

float getElevationStop(int stop) {
    // PATCH (map2-fork): stops are an R32F texture in metres too.
    float x = (float(stop)+0.5)/float(u_color_ramp_size);
    return texture(u_elevation_stops, vec2(x, 0)).r;
}

void main() {
    float el = mix(getElevation(v_pos), texture(u_image_parent, v_pos_parent).r, u_fade_t);

    // Binary search
    int r = (u_color_ramp_size - 1);
    int l = 0;
    float el_l = getElevationStop(l);
    float el_r = getElevationStop(r);
    while(r - l > 1)
    {
        int m = (r + l) / 2;
        float el_m = getElevationStop(m);
        if(el < el_m)
        {
            r = m;
            el_r = el_m;
        }
        else
        {
            l = m;
            el_l = el_m;
        }
    }

    float x = (float(l) + (el - el_l) / (el_r - el_l) + 0.5)/float(u_color_ramp_size);
    fragColor = u_opacity*texture(u_color_stops, vec2(x, 0));

#ifdef OVERDRAW_INSPECTOR
    fragColor = vec4(1.0);
#endif
}
