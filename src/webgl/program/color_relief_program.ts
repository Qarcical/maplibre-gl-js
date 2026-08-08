import {
    Uniform1i,
    Uniform1f,
    Uniform2f
} from '../uniform_binding';

import type {Context} from '../../webgl/context';
import type {UniformValues, UniformLocations} from '../uniform_binding';
import type {ColorReliefStyleLayer} from '../../style/style_layer/color_relief_style_layer';
import type {DEMData} from '../../data/dem_data';
import type {DemFadeValues} from './hillshade_program';

export type ColorReliefUniformsType = {
    'u_image': Uniform1i;
    'u_dimension': Uniform2f;
    'u_elevation_stops': Uniform1i;
    'u_color_stops': Uniform1i;
    'u_color_ramp_size': Uniform1i;
    'u_opacity': Uniform1f;
    // PATCH (map2-fork): raster-dem tile-transition cross-fade (see draw_color_relief)
    'u_image_parent': Uniform1i;
    'u_tl_parent': Uniform2f;
    'u_scale_parent': Uniform1f;
    'u_fade_t': Uniform1f;
};

const colorReliefUniforms = (context: Context, locations: UniformLocations): ColorReliefUniformsType => ({
    'u_image': new Uniform1i(context, locations.u_image),
    'u_dimension': new Uniform2f(context, locations.u_dimension),
    'u_elevation_stops': new Uniform1i(context, locations.u_elevation_stops),
    'u_color_stops': new Uniform1i(context, locations.u_color_stops),
    'u_color_ramp_size': new Uniform1i(context, locations.u_color_ramp_size),
    'u_opacity': new Uniform1f(context, locations.u_opacity),
    'u_image_parent': new Uniform1i(context, locations.u_image_parent),
    'u_tl_parent': new Uniform2f(context, locations.u_tl_parent),
    'u_scale_parent': new Uniform1f(context, locations.u_scale_parent),
    'u_fade_t': new Uniform1f(context, locations.u_fade_t)
});

const colorReliefUniformValues = (
    layer: ColorReliefStyleLayer,
    dem: DEMData,
    colorRampSize: number = 0,
    fade?: DemFadeValues
): UniformValues<ColorReliefUniformsType> => {

    // PATCH (map2-fork): edge tiles with no parent self-fade through the layer opacity;
    // cross-fades mix elevations in-shader instead (u_fade_t toward the parent sampler).
    return {
        'u_image': 0,
        'u_dimension': [dem.stride, dem.stride],
        'u_elevation_stops': 1,
        'u_color_stops': 4,
        'u_color_ramp_size': colorRampSize,
        'u_opacity': layer.paint.get('color-relief-opacity') * (fade ? fade.fadeMix.opacity : 1),
        'u_image_parent': 5,
        'u_tl_parent': fade ? fade.parentTopLeft : [0, 0],
        'u_scale_parent': fade ? fade.parentScaleBy : 1,
        'u_fade_t': fade?.parentTile ? fade.fadeMix.mix : 0
    };
};

export {
    colorReliefUniforms,
    colorReliefUniformValues,
};
