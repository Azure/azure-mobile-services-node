// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module supports sending push notifications to Windows Phone 8 clients using 
// Microsoft Push Notification Services

var core = require('../../core'),
	mpns = require('mpns'),
    notify = require('./notify');

exports.createMpnsContext = function () {

	// - channel URL is passed to callbacks as part of the result or error object
    function visitResult(item, args) {
        if (core.isObject(item)) {
            // add channel information to result; the channel should be the first argument
            item.channel = args[0];
        }
        return item;
    }

    var result = {};

    for (var method in mpns) {
        if (method.indexOf('send') === 0) {
            result[method] = notify.createWrapper(mpns, method, 2, "mpns");
        }
    }

    return result;
};
