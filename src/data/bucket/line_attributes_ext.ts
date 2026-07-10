import {createLayout} from '../../util/struct_array';

export const lineLayoutAttributesExt = createLayout([
    {name: 'a_uv_x', components: 1, type: 'Float32'},
    {name: 'a_split_index', components: 1, type: 'Float32'},
    // progress along the WHOLE feature (0..1), not renormalized per tile split like
    // a_uv_x — the line progress clip compares against this so a clip fraction means
    // the same thing in every tile the feature crosses
    {name: 'a_global_progress', components: 1, type: 'Float32'},
]);

export const {members, size, alignment} = lineLayoutAttributesExt;
