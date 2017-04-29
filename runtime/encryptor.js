// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This module has encryption and decryption utility methods

var crypto = require('crypto');

function Encryptor() {
}

Encryptor.encrypt = (key, plaintext) => {
    if (typeof plaintext !== 'string') {
        throw new Error('plaintext must be a string.');
    }
    var cipher = crypto.createCipher('aes-256-cbc', key);
    var data = cipher.update(plaintext, 'utf8', 'base64') + cipher.final('base64');
    return data;
};

Encryptor.decrypt = (key, data) => {
    var cipher = crypto.createDecipher('aes-256-cbc', key);
    var plaintext = cipher.update(data, 'base64', 'utf8') + cipher.final('utf8');
    return plaintext;
};

exports = module.exports = Encryptor;