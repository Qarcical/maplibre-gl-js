uniform mat4 u_matrix;
// PATCH (map2-fork): fading-parent sampling geometry (see raster.vertex.glsl) — the
// cross-fade for raster-dem tile transitions samples the parent's prepared texture.
uniform vec2 u_tl_parent;
uniform float u_scale_parent;

// PATCH (map2-fork): the prepared derivative is a (dim+1)² NODE grid whose first and last
// texels sit ON the tile's edges (see hillshade_prepare.vertex.glsl), so tile space [0,1]
// maps to texel centres [0.5, dim+0.5] / (dim+1) rather than straight to [0,1].
// x = scale, y = offset.
uniform vec2 u_node_map;

in vec2 a_pos;

out vec2 v_pos;
out vec2 v_pos_parent;
// Tile-space y, kept separate from the (now inset) texture coordinate so the fragment's
// latitude term still runs edge-to-edge and stays continuous across a tile boundary.
out float v_tile_y;

void main() {
    gl_Position = projectTile(a_pos, a_pos);
    vec2 tile_pos = a_pos / 8192.0;
    // North pole
    if (a_pos.y < -32767.5) {
        tile_pos.y = 0.0;
    }
    // South pole
    if (a_pos.y > 32766.5) {
        tile_pos.y = 1.0;
    }
    v_tile_y = tile_pos.y;
    v_pos = tile_pos * u_node_map.x + u_node_map.y;
    v_pos_parent = ((tile_pos * u_scale_parent) + u_tl_parent) * u_node_map.x + u_node_map.y;
}
