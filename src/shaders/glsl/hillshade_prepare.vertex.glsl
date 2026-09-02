uniform mat4 u_matrix;
uniform vec2 u_dimension;

in vec2 a_pos;
in vec2 a_texture_pos;

out vec2 v_pos;

void main() {
    gl_Position = u_matrix * vec4(a_pos, 0, 1);

    // PATCH (map2-fork): node-centred derivative grid. The render target is (dim+1)²
    // and its texel j represents the NODE between DEM samples j-1 and j, so v_pos lands
    // exactly ON the boundary between two DEM texels rather than on a texel centre.
    // Tile A's last node and tile B's first node are then the same world position and
    // read the same two DEM values (one real, one backfilled), so adjacent tiles agree
    // at their shared edge — which the old cell-centred grid could not do, leaving a
    // hard seam wherever a DEM tile edge was magnified (see hillshade.vertex.glsl).
    highp vec2 texel = 1.0 / u_dimension;
    float scale = (u_dimension.x - 1.0) / u_dimension.x;
    v_pos = (a_texture_pos / 8192.0) * scale + 0.5 * texel;
}
