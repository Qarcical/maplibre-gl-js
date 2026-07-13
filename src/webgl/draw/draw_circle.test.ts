// PATCH (map2-fork): uniform-anchored circles (Map#setCircleAnchorOverride) — the
// challenge animation's playhead moves by uniform instead of per-frame setData
// (two worker round trips per visible move froze the head on phones).
import {describe, test, expect, vi, type Mock} from 'vitest';
import {mat4} from 'gl-matrix';
import {OverscaledTileID} from '../../tile/tile_id';
import {TileManager} from '../../tile/tile_manager';
import {Tile} from '../../tile/tile';
import {Painter, type RenderOptions} from '../../render/painter';
import {Program} from '../program';
import type {ZoomHistory} from '../../style/zoom_history';
import {type IReadonlyTransform} from '../../geo/transform_interface';
import type {EvaluationParameters} from '../../style/evaluation_parameters';
import type {CircleLayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import {type Style} from '../../style/style';
import {CircleStyleLayer} from '../../style/style_layer/circle_style_layer';
import {drawCircles} from './draw_circle';
import {CircleBucket} from '../../data/bucket/circle_bucket';
import {type ProgramConfiguration, type ProgramConfigurationSet} from '../../data/program_configuration';
import type {ProjectionData} from '../../geo/projection/projection_data';
import {MercatorCoordinate} from '../../geo/mercator_coordinate';
import {LngLat} from '../../geo/lng_lat';

vi.mock('../../render/painter');
vi.mock('../program');
vi.mock('../../tile/tile_manager');
vi.mock('../../tile/tile');

describe('drawCircles anchor override', () => {
    function constructMockLayer(): CircleStyleLayer {
        const layerSpec = {
            id: 'mock-circle-layer',
            source: 'empty-source',
            type: 'circle',
            layout: {},
            paint: {}
        } as CircleLayerSpecification;
        const layer = new CircleStyleLayer(layerSpec, {});
        layer.recalculate({zoom: 0, zoomHistory: {} as ZoomHistory} as EvaluationParameters, []);
        return layer;
    }

    function constructMockPainter(elevation: number): Painter {
        const painterMock = new Painter(null as any, null as any);
        painterMock.context = {
            gl: {}
        } as any;
        painterMock.renderPass = 'translucent';
        painterMock.transform = {
            pitch: 0,
            zoom: 0,
            tileZoom: 0,
            angle: 0,
            pixelsToGLUnits: [1, 1],
            cameraToCenterDistance: 1,
            getCircleRadiusCorrection: () => 1,
            getProjectionData(_params): ProjectionData {
                const fallback = mat4.create();
                return {
                    mainMatrix: fallback,
                    tileMercatorCoords: [0, 0, 1, 1],
                    clippingPlane: [0, 0, 0, 0],
                    projectionTransition: 0.0,
                    fallbackMatrix: fallback,
                };
            },
        } as any as IReadonlyTransform;
        painterMock.pixelRatio = 1;
        painterMock.options = {} as any;
        painterMock.style = {
            map: {
                projection: {},
                terrain: {
                    getTerrainData: () => null,
                    getElevationForLngLatZoom: () => elevation,
                }
            }
        } as any as Style;
        return painterMock;
    }

    function constructMockTile(layer: CircleStyleLayer, tileId: OverscaledTileID): Tile {
        tileId.terrainRttPosMatrix32f = mat4.create();
        const tile = new Tile(tileId, 256);
        tile.tileID = tileId;
        const bucketMock = new CircleBucket({layers: [layer]} as any);
        const mockProgramConfigurations: ProgramConfigurationSet<CircleStyleLayer> = {} as any;
        const mockProgramConfiguration: ProgramConfiguration = {} as any;
        mockProgramConfigurations.get = () => mockProgramConfiguration;
        bucketMock.programConfigurations = mockProgramConfigurations;
        bucketMock.segments = {} as any;
        (tile.getBucket as Mock).mockReturnValue(bucketMock);
        return tile;
    }

    function setup(elevation: number) {
        const painterMock = constructMockPainter(elevation);
        const layer = constructMockLayer();
        const programMock = new Program(null as any, null as any, null as any, null as any, null as any, null as any, null as any, null as any);
        (painterMock.useProgram as Mock).mockReturnValue(programMock);
        const coordA = new OverscaledTileID(1, 0, 1, 0, 0);
        const coordB = new OverscaledTileID(1, 0, 1, 1, 0);
        const tiles = new Map<string, Tile>([
            [coordA.key, constructMockTile(layer, coordA)],
            [coordB.key, constructMockTile(layer, coordB)],
        ]);
        const tileManagerMock = new TileManager(null as any, null as any, null as any);
        (tileManagerMock.getTile as Mock).mockImplementation((coord: OverscaledTileID) => tiles.get(coord.key));
        const renderOptions: RenderOptions = {isRenderingToTexture: false, isRenderingGlobe: false} as RenderOptions;
        return {painterMock, layer, programMock, tileManagerMock, coordA, coordB, renderOptions};
    }

    test('no override: draws every tile with a zeroed override uniform', () => {
        const {painterMock, layer, programMock, tileManagerMock, coordA, coordB, renderOptions} = setup(0);
        drawCircles(painterMock, tileManagerMock, layer, [coordA, coordB], renderOptions);
        expect(programMock.draw).toHaveBeenCalledTimes(2);
        const uniformValues = (programMock.draw as Mock).mock.calls[0][6];
        expect(uniformValues.u_anchor_override).toEqual([0, 0, 0, 0]);
    });

    test('override: draws exactly one tile, anchored at the tile point with queried elevation', () => {
        const {painterMock, layer, programMock, tileManagerMock, coordA, coordB, renderOptions} = setup(321);
        layer.anchorOverride = {lng: 0, lat: 0};
        drawCircles(painterMock, tileManagerMock, layer, [coordA, coordB], renderOptions);
        // absolute anchor: a second draw would stack the same translucent circle on itself
        expect(programMock.draw).toHaveBeenCalledTimes(1);
        const uniformValues = (programMock.draw as Mock).mock.calls[0][6];
        const expected = coordA.getTilePoint(MercatorCoordinate.fromLngLat(new LngLat(0, 0)));
        expect(uniformValues.u_anchor_override).toEqual([expected.x, expected.y, 321, 1]);
    });

    test('override without terrain: elevation uniform is zero', () => {
        const {painterMock, layer, programMock, tileManagerMock, coordA, renderOptions} = setup(321);
        (painterMock.style.map as any).terrain = null;
        layer.anchorOverride = {lng: 0, lat: 0};
        drawCircles(painterMock, tileManagerMock, layer, [coordA], renderOptions);
        const uniformValues = (programMock.draw as Mock).mock.calls[0][6];
        expect(uniformValues.u_anchor_override[2]).toBe(0);
        expect(uniformValues.u_anchor_override[3]).toBe(1);
    });
});
