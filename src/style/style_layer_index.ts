import {createStyleLayer} from './create_style_layer';
import {featureFilter, groupByLayout} from '@maplibre/maplibre-gl-style-spec';
import {GEOJSON_TILE_LAYER_NAME} from '../data/feature_index';
import type {StyleLayer} from './style_layer';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';

export type LayerConfigs = {[_: string]: LayerSpecification};

export class StyleLayerIndex {
    familiesBySource: {
        [source: string]: {
            [sourceLayer: string]: StyleLayer[][];
        };
    };
    keyCache: {[source: string]: string};

    _layerConfigs: LayerConfigs;
    _layers: {[_: string]: StyleLayer};

    constructor(layerConfigs?: LayerSpecification[] | null, globalState?: Record<string, any>) {
        this.keyCache = {};
        if (layerConfigs) {
            this.replace(layerConfigs, globalState);
        }
    }

    replace(layerConfigs: LayerSpecification[], globalState?: Record<string, any>) {
        this._layerConfigs = {};
        this._layers = {};
        this.update(layerConfigs, [], globalState);
    }

    update(layerConfigs: LayerSpecification[], removedIds: string[], globalState?: Record<string, any>) {
        for (const layerConfig of layerConfigs) {
            this._layerConfigs[layerConfig.id] = layerConfig;

            const layer = this._layers[layerConfig.id] = createStyleLayer(layerConfig, globalState);
            layer._featureFilter = featureFilter(layer.filter, globalState);
            if (this.keyCache[layerConfig.id])
                delete this.keyCache[layerConfig.id];
        }
        for (const id of removedIds) {
            delete this.keyCache[id];
            delete this._layerConfigs[id];
            delete this._layers[id];
        }

        this.familiesBySource = {};

        const groups = groupByLayout(Object.values(this._layerConfigs), this.keyCache);

        // PATCH (map2-fork): a family shares ONE bucket, and the worker skips whole
        // families whose mode tag excludes the parse's render mode — so layers with
        // different `map2:visible-when` tags must never share a family. groupByLayout
        // (style-spec) can't see the tag; subdivide its groups here.
        const modeSplitGroups: LayerSpecification[][] = [];
        for (const layerConfigs of groups) {
            const byMode: {[key: string]: LayerSpecification[]} = {};
            for (const layerConfig of layerConfigs) {
                const mode = this._layers[layerConfig.id].visibleWhen ?? '';
                (byMode[mode] ||= []).push(layerConfig);
            }
            for (const mode in byMode) {
                modeSplitGroups.push(byMode[mode]);
            }
        }

        for (const layerConfigs of modeSplitGroups) {
            const layers = layerConfigs.map((layerConfig) => this._layers[layerConfig.id]);

            const layer = layers[0];
            if (layer.isHidden()) {
                continue;
            }

            const sourceId = layer.source || '';
            let sourceGroup = this.familiesBySource[sourceId];
            sourceGroup ||= this.familiesBySource[sourceId] = {};

            const sourceLayerId = layer.sourceLayer || GEOJSON_TILE_LAYER_NAME;
            let sourceLayerFamilies = sourceGroup[sourceLayerId];
            sourceLayerFamilies ||= sourceGroup[sourceLayerId] = [];

            sourceLayerFamilies.push(layers);
        }
    }
}
