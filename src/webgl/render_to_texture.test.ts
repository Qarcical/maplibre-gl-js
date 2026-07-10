import {beforeEach, describe, test, expect, vi, type Mock} from 'vitest';
import {RenderToTexture} from './render_to_texture';
import type {Painter} from '../render/painter';
import type {LineStyleLayer} from '../style/style_layer/line_style_layer';
import type {SymbolStyleLayer} from '../style/style_layer/symbol_style_layer';
import {Context} from '../webgl/context';
import {ColorMode} from '../webgl/color_mode';
import {Terrain} from '../render/terrain';
import {type Style} from '../style/style';
import {Tile} from '../tile/tile';
import {type Map} from '../ui/map';
import {OverscaledTileID} from '../tile/tile_id';
import {type TileManager} from '../tile/tile_manager';
import {type TerrainSpecification} from '@maplibre/maplibre-gl-style-spec';
import {type FillStyleLayer} from '../style/style_layer/fill_style_layer';
import {type RasterStyleLayer} from '../style/style_layer/raster_style_layer';
import {type HillshadeStyleLayer} from '../style/style_layer/hillshade_style_layer';
import {type BackgroundStyleLayer} from '../style/style_layer/background_style_layer';
import {DepthMode} from '../webgl/depth_mode';

describe('render to texture', () => {
    const gl = document.createElement('canvas').getContext('webgl');
    vi.spyOn(gl, 'checkFramebufferStatus').mockReturnValue(gl.FRAMEBUFFER_COMPLETE);
    const backgroundLayer = {
        id: 'maine-background',
        type: 'background',
        source: 'maine',
        isHidden: () => false
    } as any as BackgroundStyleLayer;
    const fillLayer = {
        id: 'maine-fill',
        type: 'fill',
        source: 'maine',
        isHidden: () => false
    } as any as FillStyleLayer;
    const rasterLayer = {
        id: 'maine-raster',
        type: 'raster',
        source: 'maine',
        isHidden: () => false
    } as any as RasterStyleLayer;
    const hillshadeLayer = {
        id: 'maine-hillshade',
        type: 'line',
        source: 'maine',
        isHidden: () => false
    } as any as HillshadeStyleLayer;
    const lineLayer = {
        id: 'maine-line',
        type: 'line',
        source: 'maine',
        isHidden: () => false
    } as any as LineStyleLayer;
    const breakLineLayer = {
        id: 'maine-line-break',
        type: 'line',
        source: 'maine',
        metadata: {'map2:rtt-stack-break': true},
        isHidden: () => false
    } as any as LineStyleLayer;
    const symbolLayer = {
        id: 'maine-symbol',
        type: 'symbol',
        source: 'maine',
        layout: {
            'text-field': 'maine',
            'symbol-placement': 'line'
        },
        isHidden: () => false
    } as any as SymbolStyleLayer;

    let layersDrawn = 0;
    const painter = {
        layersDrawn: 0,
        context: new Context(gl),
        transform: {zoom: 10, calculatePosMatrix: () => {}, getProjectionData(_a) {}, calculateFogMatrix: () => {}},
        colorModeForRenderPass: () => ColorMode.alphaBlended,
        getDepthModeFor3D: () => DepthMode.disabled,
        useProgram: () => ({draw: () => { layersDrawn++; }}),
        _renderTileClippingMasks: vi.fn(),
        renderLayer: vi.fn(),
        drawFunctions: {
            terrainDepth: vi.fn(),
            terrainCoords: vi.fn(),
        }
    } as any as Painter;
    const map = {painter} as Map;

    const tile = new Tile(new OverscaledTileID(3, 0, 2, 1, 2), 512);
    // buckets so the stack content check sees these layers as drawable on the tile
    tile.buckets = {
        'maine-fill': {} as any,
        'maine-hillshade': {} as any,
        'maine-line': {} as any,
        'maine-line-break': {} as any
    };
    const tileManager = {
        _source: {minzoom: 0, maxzoom: 2},
        getTileByID: (_id) => tile,
        getVisibleCoordinates: () => [tile.tileID]
    } as TileManager;

    const style = {
        tileManagers: {
            'maine': {
                getVisibleCoordinates: () => [tile.tileID],
                getTileByID: (_id) => tile,
                getSource: () => ({}),
                getState: vi.fn().mockReturnValue({revision: 0})
            }
        },
        _order: ['maine-fill', 'maine-symbol'],
        _layers: {
            'maine-background': backgroundLayer,
            'maine-fill': fillLayer,
            'maine-raster': rasterLayer,
            'maine-hillshade': hillshadeLayer,
            'maine-line': lineLayer,
            'maine-line-break': breakLineLayer,
            'maine-symbol': symbolLayer
        },
        projection: {
            transitionState: 0,
        }
    } as any as Style;
    painter.style = style;
    map.style = style;
    style.map = map;

    const terrain = new Terrain(painter, tileManager, {} as any as TerrainSpecification);
    vi.spyOn(terrain.tileManager, 'getRenderableTiles').mockReturnValue([tile]);
    vi.spyOn(terrain.tileManager, 'getTerrainCoords').mockReturnValue({[tile.tileID.key]: tile.tileID});
    map.terrain = terrain;

    const rtt = new RenderToTexture(painter, terrain);
    rtt.prepareForRender(style, 0);
    painter.renderToTexture = rtt;

    beforeEach(() => {
        tile.rtt = [];
        tile.rttFingerprint = {};
    });

    test('should call painter with overlay tiles for terrain tile', () => {
        const renderLayerSpy = vi.spyOn(painter, 'renderLayer');
        rtt.prepareForRender(style, 0);

        const renderOptions = {isRenderingToTexture: false, isRenderingGlobe: false};
        for (const layerId of style._order) {
            const layer = style._layers[layerId];
            rtt.renderLayer(layer, renderOptions);
        }

        expect(renderLayerSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({id: 'maine-fill'}),
            [tile.tileID],
            expect.anything()
        );
    });

    test('should clear tile cache when overlaid tiles change', () => {
        rtt.prepareForRender(style, 0);

        tile.rttFingerprint = {maine: '923#0'};
        tile.rtt = [{pool: 0, id: 1, stamp: 123}];

        const otherTileID = new OverscaledTileID(3, 0, 2, 2, 2);
        (terrain.tileManager.getTerrainCoords as Mock).mockReturnValueOnce({[tile.tileID.key]: otherTileID});

        rtt.prepareForRender(style, 0);

        expect(tile.rtt[0]).toBeNull();
    });

    test('should not clear tile cache if state remains same', () => {
        rtt.prepareForRender(style, 0);
        tile.rttFingerprint = {maine: '923#0'};
        tile.rtt = [{pool: 0, id: 1, stamp: 123}];

        rtt.prepareForRender(style, 0);

        expect(tile.rtt.length).toBe(1);
    });

    test('should render text after a line by not adding the text to the stack', () => {
        style._order = ['maine-fill', 'maine-symbol'];
        rtt.prepareForRender(style, 0);
        layersDrawn = 0;
        const renderOptions = {isRenderingToTexture: false, isRenderingGlobe: false};
        expect(rtt._renderableLayerIds).toStrictEqual(['maine-fill', 'maine-symbol']);
        expect(rtt.renderLayer(fillLayer, renderOptions)).toBeTruthy();
        expect(rtt.renderLayer(symbolLayer, renderOptions)).toBeFalsy();
        expect(layersDrawn).toBe(1);
    });

    test('render symbol between rtt layers', () => {
        style._order = ['maine-background', 'maine-fill', 'maine-raster', 'maine-hillshade', 'maine-symbol', 'maine-line', 'maine-symbol'];
        rtt.prepareForRender(style, 0);
        layersDrawn = 0;
        const renderOptions = {isRenderingToTexture: false, isRenderingGlobe: false};
        expect(rtt._renderableLayerIds).toStrictEqual(['maine-background', 'maine-fill', 'maine-raster', 'maine-hillshade', 'maine-symbol', 'maine-line', 'maine-symbol']);
        expect(rtt.renderLayer(backgroundLayer, renderOptions)).toBeTruthy();
        expect(rtt.renderLayer(fillLayer, renderOptions)).toBeTruthy();
        expect(rtt.renderLayer(rasterLayer, renderOptions)).toBeTruthy();
        expect(rtt.renderLayer(hillshadeLayer, renderOptions)).toBeTruthy();
        expect(rtt.renderLayer(symbolLayer, renderOptions)).toBeFalsy();
        expect(rtt.renderLayer(lineLayer, renderOptions)).toBeTruthy();
        expect(rtt.renderLayer(symbolLayer, renderOptions)).toBeFalsy();
        expect(layersDrawn).toBe(2);
    });

    test('render more symbols between rtt layers', () => {
        style._order = ['maine-background', 'maine-symbol', 'maine-hillshade', 'maine-symbol', 'maine-line', 'maine-symbol'];
        rtt.prepareForRender(style, 0);
        layersDrawn = 0;
        const renderOptions = {isRenderingToTexture: false, isRenderingGlobe: false};
        expect(rtt._renderableLayerIds).toStrictEqual(['maine-background', 'maine-symbol', 'maine-hillshade', 'maine-symbol', 'maine-line', 'maine-symbol']);
        expect(rtt.renderLayer(backgroundLayer, renderOptions)).toBeTruthy();
        expect(rtt.renderLayer(symbolLayer, renderOptions)).toBeFalsy();
        expect(rtt.renderLayer(hillshadeLayer, renderOptions)).toBeTruthy();
        expect(rtt.renderLayer(symbolLayer, renderOptions)).toBeFalsy();
        expect(rtt.renderLayer(lineLayer, renderOptions)).toBeTruthy();
        expect(rtt.renderLayer(symbolLayer, renderOptions)).toBeFalsy();
        expect(layersDrawn).toBe(3);
    });

    test('should clear tile cache on source state update', () => {
        const state = {revision: 0};
        (style.tileManagers['maine'].getState as Mock).mockReturnValue(state);

        tile.rtt = [{pool: 0, id: 1, stamp: 123}];
        tile.rttFingerprint = {maine: '923#0'};

        rtt.prepareForRender(style, 0);
        expect(tile.rtt.length).toBe(1);

        state.revision = 1;
        rtt.prepareForRender(style, 0);
        expect(tile.rtt[0]).toBeNull();
    });

    test('metadata stack break renders the prior stack and starts a new one', () => {
        style._order = ['maine-fill', 'maine-line-break'];
        rtt.prepareForRender(style, 0);
        layersDrawn = 0;
        const renderOptions = {isRenderingToTexture: false, isRenderingGlobe: false};
        expect(rtt.renderLayer(fillLayer, renderOptions)).toBeTruthy();
        expect(rtt.renderLayer(breakLineLayer, renderOptions)).toBeTruthy();
        expect(rtt._stacks).toStrictEqual([['maine-fill'], ['maine-line-break']]);
        // one terrain composite per stack, one tile each
        expect(layersDrawn).toBe(2);
    });

    test('markSourceTileChanged invalidates only stacks draping the source', () => {
        style._order = ['maine-fill', 'maine-symbol'];
        (style.tileManagers['maine'].getState as Mock).mockReturnValue({revision: 0});
        (terrain.tileManager as any)._tiles = {[tile.tileID.key]: tile};
        rtt.prepareForRender(style, 0);

        tile.rtt = [{pool: 0, id: 1, stamp: 123}];
        tile.rttFingerprint = {maine: '923#0'};

        // a source with no draped layers (e.g. one only used by symbols) changes nothing
        rtt.markSourceTileChanged('not-draped', tile.tileID);
        rtt.prepareForRender(style, 0);
        expect(tile.rtt[0]).toStrictEqual({pool: 0, id: 1, stamp: 123});

        // a draped source invalidates the stack that drapes it
        rtt.markSourceTileChanged('maine', tile.tileID);
        rtt.prepareForRender(style, 0);
        expect(tile.rtt[0]).toBeNull();
    });
});
