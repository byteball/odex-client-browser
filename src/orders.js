const crypto = require('crypto');
const exchange = require('./exchange.js');
const account = require('./account.js');
const ws_api = require('./ws_api.js');
const rest_api = require('./rest_api.js');
const Decimal = require('decimal.js');
const { signMessage } = require('obyte/lib/utils');
const conf = require('./conf.js');

let assocMyOrders = {};

Decimal.set({
	precision: 15, // double precision is 15.95 https://en.wikipedia.org/wiki/IEEE_754
	rounding: Decimal.ROUND_HALF_EVEN,
	maxE: 308, // double overflows between 1.7e308 and 1.8e308
	minE: -324, // double underflows between 2e-324 and 3e-324
	toExpNeg: -7, // default, same as for js number
	toExpPos: 21, // default, same as for js number
});



function toOscriptPrecision(num) {
	return (new Decimal(num).times(1)).toString();
}

function dropExcessivePrecision(price) {
	let strPrice = price.toPrecision(conf.MAX_PRICE_PRECISION);
	return parseFloat(strPrice);
}

function getFirstAsset(sell_asset, buy_asset) {
	if (sell_asset === 'base')
		return sell_asset;
	if (buy_asset === 'base')
		return buy_asset;
	return (sell_asset < buy_asset) ? sell_asset : buy_asset;
}

function getPriceInAllowedPrecision(order_data) {
	const first_asset = getFirstAsset(order_data.sell_asset, order_data.buy_asset);
	if (first_asset === order_data.sell_asset)
		return dropExcessivePrecision(order_data.price);
	else
		return 1 / dropExcessivePrecision(1 / order_data.price);
}

function adjustPriceToAllowedPrecision(base_asset, quote_asset, side, price) {
	let order_info = {};
	if (side === 'SELL') {
		order_info.sell_asset = base_asset;
		order_info.buy_asset = quote_asset;
	}
	else if (side === 'BUY') {
		order_info.sell_asset = quote_asset;
		order_info.buy_asset = base_asset;
	}
	else
		throw Error("unknown side: " + side);
	order_info.price = (side === "SELL") ? price : 1 / price;
	order_info.price = getPriceInAllowedPrecision(order_info);
	return (side === "SELL") ? order_info.price : 1 / order_info.price;
}

async function createOrder(pair, side, amount, price, matcher, expiry_ts) {
	let [baseToken, quoteToken] = await exchange.getTokensByPair(pair);
	
	let { matcherFee, affiliateFee } = exchange.getFees(quoteToken.symbol);

	price = adjustPriceToAllowedPrecision(baseToken.asset, quoteToken.asset, side, price);
	
	let baseMultiplier = 10 ** baseToken.decimals;
	let quoteMultiplier = 10 ** quoteToken.decimals;
	let baseAmount = amount * baseMultiplier;
	let quoteAmount = amount * price * quoteMultiplier;

	let order_info = {};
	let input_amount, output_amount;
	if (side === 'SELL') {
		order_info.sell_asset = baseToken.asset;
		order_info.buy_asset = quoteToken.asset;
		input_amount = baseAmount;
		output_amount = quoteAmount;
	}
	else if (side === 'BUY') {
		order_info.sell_asset = quoteToken.asset;
		order_info.buy_asset = baseToken.asset;
		output_amount = baseAmount;
		input_amount = quoteAmount;
	}
	else
		throw Error("unknown side: " + side);
	if (input_amount < 0.5)
		throw Error("input amount is too small: " + input_amount);
	if (output_amount < 0.5)
		throw Error("output amount is too small: " + output_amount);
	order_info.sell_amount = Math.round(input_amount);
	order_info.price = output_amount / input_amount;
	order_info.price = getPriceInAllowedPrecision(order_info);

	// fees are always paid in quote asset
	let fee_asset_amount = (order_info.sell_asset === quoteToken.asset) ? order_info.sell_amount : order_info.sell_amount * order_info.price;

	order_info.matcher = matcher || exchange.getOperatorAddress();
	order_info.matcher_fee_asset = quoteToken.asset;
	order_info.matcher_fee = Math.ceil(fee_asset_amount * matcherFee);
	if (affiliateFee && order_info.matcher !== exchange.getOperatorAddress()) {
		order_info.affiliate = exchange.getOperatorAddress();
		order_info.affiliate_fee_asset = quoteToken.asset;
		order_info.affiliate_fee = Math.ceil(fee_asset_amount * affiliateFee);			
	}
	if (expiry_ts)
		order_info.expiry_ts = expiry_ts;
	return await createOrderInAssets(order_info);
}

async function createOrderInAssets(order_info) {
	let order = {
		...order_info,
		address: account.getOwnerAddress(),
		aa: conf.aa_address,
		nonce: crypto.randomBytes(6).toString("base64"),
	};
	let signedOrder = await signMessage(order, conf);
	return signedOrder;
}

function getOrderHash(signedOrder) {
	const order_data = signedOrder.signed_message;
	let str = order_data.address + order_data.sell_asset + order_data.buy_asset + order_data.sell_amount + toOscriptPrecision(order_data.price) + (order_data.nonce || '') + (signedOrder.last_ball_unit || '-');
	return crypto.createHash("sha256").update(str, "utf8").digest("base64");
}

async function createCancel(hash) {
	let signedCancel = await signMessage('Cancel order ' + hash, conf);
	return signedCancel;
}


async function createAndSendOrder(pair, side, amount, price, matcher, expiry_ts) {
	let signedOrder = await createOrder(pair, side, amount, price, matcher, expiry_ts);
	return await ws_api.sendOrder(signedOrder) ? null : getOrderHash(signedOrder);
}

async function createAndSendCancel(hash) {
	let signedCancel = await createCancel(hash);
	return await ws_api.sendCancel(signedCancel);
}


function updateMyOrder(order) {
	if (order.originalOrder.signed_message.address !== account.getOwnerAddress())
		return;
	if (order.status === 'FILLED'){
		delete assocMyOrders[order.hash];
		ws_api.emit('my_order_removed', order.hash);
	}
	else {
		assocMyOrders[order.hash] = order;
		ws_api.emit('my_order_added', order.hash);
	}
}

async function initMyOrders() {
	let my_orders = await rest_api.fetchCurrentOrders(account.getOwnerAddress());
	for (let hash in assocMyOrders)
		delete assocMyOrders[hash];
	my_orders.forEach(order => {
		assocMyOrders[order.hash] = order;
	});
}

async function trackMyOrders() {

	ws_api.on('orders', (type, payload) => {
		console.error('---- trackMyOrders', type, payload);
		switch (type) {
			case 'ORDER_ADDED':
				var order = payload;
				if (order.status === 'OPEN' || order.status === 'PARTIAL_FILLED'){
					assocMyOrders[order.hash] = order;
					ws_api.emit('my_order_added', order.hash);
				}
				break;
			case 'ORDER_CANCELLED':
				var order = payload;
				delete assocMyOrders[order.hash];
				if (order.originalOrder.signed_message.address === account.getOwnerAddress())
					ws_api.emit('my_order_removed', order.hash);
				break;
			case 'ORDER_MATCHED':
		//	case 'ORDER_PENDING':
				let matches = payload.matches;
				updateMyOrder(matches.takerOrder);
				matches.makerOrders.forEach(updateMyOrder);
				break;
		}
	});
	if (ws_api.isConnected()){// we've already missed 'connected' event
		await initMyOrders();
	}
	ws_api.on('connected', async () => {
		await initMyOrders();
		ws_api.emit('reset_orders');
	});
}


exports.getOrderHash = getOrderHash;

exports.createOrder = createOrder;
exports.createCancel = createCancel;
exports.createAndSendOrder = createAndSendOrder;
exports.createAndSendCancel = createAndSendCancel;

exports.assocMyOrders = assocMyOrders;
exports.trackMyOrders = trackMyOrders;

