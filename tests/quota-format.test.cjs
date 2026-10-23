'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { remaining, percent, compactPercent, limitLabel } = require('../src/renderer/quota-format.js');
const { safeSettings } = require('../src/main/settings.cjs');
test('quota labels cannot invert meaning and never round away near-empty or near-full limits', () => {
 assert.equal(safeSettings({metricMode:'used'}).metricMode,'remaining');
 assert.equal(remaining({usedPercent:55}),45);
 assert.equal(percent(0.4),'0,4'); assert.equal(percent(99.6),'99,6');
 assert.equal(percent(0.04),'<0,1'); assert.equal(percent(99.99),'>99,9');
 assert.equal(compactPercent(0.4),'<1'); assert.equal(compactPercent(99.6),'>99');
 assert.equal(compactPercent(0),'0'); assert.equal(compactPercent(100),'100');
});
test('quota periods keep provider buckets and do not invent five-hour sessions', () => {
 assert.equal(limitLabel({windowMinutes:300,label:'5h'}),'Limite de 5 horas');
 assert.equal(limitLabel({windowMinutes:10080,label:'7d'}),'Semanal · 7 dias');
 assert.equal(limitLabel({windowMinutes:15,label:'Review · 15min'}),'Review · Limite de 15 minutos');
 assert.equal(limitLabel({label:'Principal'}),'Principal');
 assert.equal(limitLabel({}),'Período não informado');
});
