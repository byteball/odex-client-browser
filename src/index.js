/*jslint node: true */
'use strict';
const conf = require('./conf.js');


async function start(_conf) {
	Object.assign(conf, _conf);

	exports.ws_api = require('./ws_api.js');
	exports.rest_api = require('./rest_api.js');
	exports.orders = require('./orders.js');
	exports.balances = require('./balances.js');
	exports.exchange = require('./exchange.js');
	exports.account = require('./account.js');
	exports.signing = require('./signing.js');

	await exports.exchange.start();
	await exports.ws_api.connect();
}

exports.start = start;


//exports.account = account;