'use strict';
// A click on the floating panel or a notification activates the Mac app; that mustn't open the
// window or keep the focus, so Insert lands in the text field you were typing in.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivationGate, giveFocusBack } = require('../src/core/activation');

test('aDockClickOpensTheWindowButAClickOnThePanelOrANotificationDoesNot', () => {
  let now = 1000;
  const gate = new ActivationGate({ now: () => now, quietMs: 3000 });
  assert.equal(gate.opensWindow(), true, 'a Dock click');
  gate.quiet(); // The panel was touched, or a notification clicked.
  now += 250;
  assert.equal(gate.opensWindow(), false);
  now += 2749;
  assert.equal(gate.opensWindow(), false);
  now += 1;
  assert.equal(gate.opensWindow(), true, 'a Dock click later');
});

function fakeMac(activeFor) {
  const calls = [];
  let checks = 0, deactivated = false;
  return {
    calls,
    appActive() {
      checks++;
      return !deactivated || checks <= activeFor;
    },
    deactivate() {
      calls.push('deactivate');
      deactivated = true;
      checks = 0;
    },
  };
}

test('theFocusGoesBackToYourAppBeforeInsertWhenAClickMadeUsActive', async () => {
  const slept = [];
  const sleep = async (ms) => slept.push(ms);
  const hidden = [];
  // Active after the click; inactive two checks after deactivate.
  const mac = fakeMac(2);
  assert.equal(await giveFocusBack({ mac, hide: () => hidden.push(1), sleep }), 'deactivated');
  assert.deepEqual(mac.calls, ['deactivate']);
  assert.deepEqual(hidden, []);
  assert.equal(slept.at(-1), 80, 'a moment for the field to get the focus back');
});

test('itHidesTheAppWhenDeactivatingDoesntTake', async () => {
  const hidden = [];
  const mac = fakeMac(Infinity);
  assert.equal(await giveFocusBack({ mac, hide: () => hidden.push(1), sleep: async () => {}, waitMs: 100 }), 'hidden');
  assert.deepEqual(hidden, [1]);
});

test('nothingHappensWhenAnotherAppIsInFrontOrOffMacOS', async () => {
  const mac = { appActive: () => false, deactivate: () => assert.fail('not ours to deactivate') };
  assert.equal(await giveFocusBack({ mac, hide: () => assert.fail(), sleep: async () => {} }), 'not-active');
  assert.equal(await giveFocusBack({ mac: null, hide: () => assert.fail(), sleep: async () => {} }), 'unavailable');
});
