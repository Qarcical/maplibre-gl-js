uniform mat4 u_matrix;
// PATCH (map2-fork): fading-parent sampling geometry (see raster.vertex.glsl) — the
// cross-fade for raster-dem tile transitions samples the parent's prepared texture.
uniform vec2 u_tl_parent;
uniform float u_scale_parent;

in vec2 a_pos;

out vec2 v_pos;
out vec2 v_pos_parent;

void main() {
    gl_Position = projectTile(a_pos, a_pos);
    v_pos = a_pos / 8192.0;
    // North pole
    if (a_pos.y < -32767.5) {
        v_pos.y = 0.0;
    }
    // South pole
    if (a_pos.y > 32766.5) {
        v_pos.y = 1.0;
    }
    v_pos_parent = (v_pos * u_scale_parent) + u_tl_parent;
}
