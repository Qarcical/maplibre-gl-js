import {beforeEach, test, expect} from 'vitest';
import {createMap, beforeMapTest} from '../../util/test/util';

// PATCH (map2-fork): frame-rate governor transition hold (Map#holdFrameRateTier) —
// scripted transitions suppress DEMOTIONS so a camera-masked transient can't buy
// the 10s step-up cooldown; promotions are unaffected.

beforeEach(() => {
    beforeMapTest();
});

/** a decision window whose main-thread cost overruns the 60fps budget */
function seedOverloadedWindow(map) {
    map._rafDeltas = new Array(16).fill(1000 / 60);
    map._framePerf = Array.from({length: 24}, () => ({cpu: 30, gpu: 10, depth: 1}));
}

test('an overloaded window demotes the governed tier', () => {
    const map = createMap();
    map.setMaxFrameRate('auto');
    seedOverloadedWindow(map);
    map._maybeAdaptFrameRate();
    expect(map._frameRateTier).toBe(1);
});

test('holdFrameRateTier suppresses demotion; cancelling restores it', () => {
    const map = createMap();
    map.setMaxFrameRate('auto');
    map.holdFrameRateTier(60000);
    seedOverloadedWindow(map);
    map._maybeAdaptFrameRate();
    expect(map._frameRateTier).toBe(0);      // held through the transient

    map.holdFrameRateTier(0);                // cancel the hold
    seedOverloadedWindow(map);
    map._maybeAdaptFrameRate();
    expect(map._frameRateTier).toBe(1);      // demotes normally again
});

test('a hold does not block promotion', () => {
    const map = createMap();
    map.setMaxFrameRate('auto');
    map._frameRateTier = 1;
    map._maxFrameInterval = (1000 / 60) * 2;
    map._tierHeadroomStreak = 10;            // streak requirement already met
    map._stepUpBlockedUntil = 0;
    map.holdFrameRateTier(60000);
    map._rafDeltas = new Array(16).fill(1000 / 60);
    map._framePerf = Array.from({length: 24}, () => ({cpu: 2, gpu: 2, depth: 0}));
    map._maybeAdaptFrameRate();
    expect(map._frameRateTier).toBe(0);      // promoted while held
});
