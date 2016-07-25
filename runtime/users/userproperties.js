// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This class is used to serialize and deserialize user properties 
// properties is an object with following structure
// { secrets: { ... }, claims: {... } }
// where secrets and claims are key value pairs of data about user

var Encryptor = require('../encryptor'),
    VERSION = 1, // version of encryption algorithm
    KEYID = 0; // in future when we support key rollover, we will increment this every time key changes
               // we will keep at least two master keys (with their key ids) at all times i.e. current and previous

function UserProperties(masterKey) {
    this.encryptionKey = masterKey + 'USR';
}

// serializes an object with secrets and claims to JSON serialized string with encrypted secrets
UserProperties.prototype.pack = function (properties) {
    if (properties.secrets) {
        properties.secrets = this._encrypt(properties.secrets);
    }

    var value = JSON.stringify(properties);
    return value;
};

// deserializes JSON string into user properties object and decrypts the secrets
UserProperties.prototype.unpack = function (data) {
    if (!data) {
        return null;
    }

    var properties = JSON.parse(data);

    if (properties.secrets) {
        properties.secrets = this._decrypt(properties.secrets);
    }
    return properties;
};

UserProperties.prototype._encrypt = function (secrets) {
    var data = Encryptor.encrypt(this.encryptionKey, JSON.stringify(secrets));
    var ver = VERSION;
    var keyid = KEYID;
    var payload = [ver, keyid, data].join(':');
    return payload;
};

UserProperties.prototype._decrypt = function (payload) {
    if (!payload) {
        return null;
    }

    var tokens = payload.split(':');
    if (tokens.length < 3) {
        throw new Error('Failed to decrypt user properties. Unrecognized format.');
    }

    var ver = parseInt(tokens[0], 10);
    var keyId = parseInt(tokens[1], 10);
    var data = tokens.slice(2).join(':');

    if (keyId !== KEYID || ver !== VERSION) {
        throw new Error('Failed to decrypt user properties. Key or version mismatch.');
    }

    var secrets = JSON.parse(Encryptor.decrypt(this.encryptionKey, data));
    return secrets;
};

exports = module.exports = UserProperties;