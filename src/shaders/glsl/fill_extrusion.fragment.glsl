in vec4 v_color;

// map2 fork: clip extruded buildings to the challenge plate window (tile units).
// Disabled = a huge rect that never discards (set by map.setExtrusionClipRect(null)).
uniform vec4 u_clip_rect;
in vec2 v_clip_pos;

void main() {
    if (v_clip_pos.x < u_clip_rect.x || v_clip_pos.y < u_clip_rect.y ||
        v_clip_pos.x > u_clip_rect.z || v_clip_pos.y > u_clip_rect.w) {
        discard;
    }

    fragColor = v_color;

    #ifdef OVERDRAW_INSPECTOR
        fragColor = vec4(1.0);
    #endif
}
