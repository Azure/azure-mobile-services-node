// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This class encapsulates the business logic for promoting anonymous user to registered user and adding identity of an existing user

var _ = require('underscore'),
    _str = require('underscore.string'),
    core = require('../core.js'),
    Storage = require('../storage/storage.js'),
    UserStore = require('./userstore.js'),
    UserProperties = require('./userproperties'),
    logSource = 'UserService';

_.mixin(_str.exports());

function UserService(logger, userStore, userProperties, encryptClaims) {
    this.logger = logger;
    this.userStore = userStore;
    this.userProperties = userProperties;
    this.encryptClaims = encryptClaims;
}

// checks if user feature is enabled
UserService.prototype.isEnabled = function (callback) {
    var self = this;

    this.userStore.isEnabled(function (err, isEnabled) {
        if (err) {
            return self._handleStorageError(err, callback);
        }

        callback(null, isEnabled);
    });
};

// returns user identities object that is a key value pair of provider and properties
UserService.prototype.getUserIdentities = function (id, callback) {
    var self = this;

    this.getUserById(id, function (err, user) {
        if (err) {
            callback(err);
            return;
        }

        var identities = {};

        if (user) {
            // transform user object into following structure
            // { microsoft: { userId: 1234, email: 'someone@example.com'},
            //   facebook: { userId: 345, name: 'john' } }
            self._getAllProviderProperties(user)
                .forEach(function (item) {
                    if (item.properties) {
                        var identity = self._userPropertiesToIdentity(item.provider, item.providerId, item.properties);
                        identities[item.provider] = identity;
                    }
                });
        }

        callback(null, identities);
    });
};

// retrieve the user by its unique id
UserService.prototype.getUserById = function (id, callback) {
    var self = this;

    this.userStore.getUserById(id, function (err, user) {
        if (err) {
            return self._handleStorageError(err, callback);
        }

        if (user) {
            // provider properties are packed in storage and need to be unpacked
            self._getAllProviderProperties(user)
                .forEach(function (item) {
                    user[item.key] = self.userProperties.unpack(item.properties);
                });
        }        
        
        callback(null, user);
    });
};

// adds a new user or updates an existing user with new identity on a 3rd party network
// properties is an object with following structure
// { secrets: { ... }, claims: {... } }
UserService.prototype.addUserIdentity = function (provider, providerId, properties, callback) {
    var self = this;

    // move claims to secrets section for storage if encryption of claims is enabled
    if (this.encryptClaims && properties.claims) {
        var secrets = properties.secrets || {};
        properties.secrets = _.extend(secrets, properties.claims);
        delete properties.claims;
    }

    properties = this.userProperties.pack(properties);

    this.userStore.getUserByProviderId(provider, providerId, function (err, user) {
        if (err) {
            return self._handleStorageError(err, callback);
        }

        if (user) {
            self._addIdentityToUser(user, provider, providerId, properties, callback);
        }
        else {
            self._createUser(provider, providerId, properties, callback);
        }
    });
};

// returns all providers on user object
UserService.prototype._getAllProviderProperties = function (user) {
    // user table in database has columns for each provider, prefixed by provider name
    var allProperties = _.filter(Object.keys(user), function (propName) { return _.endsWith(propName, 'Properties'); })
                         .map(function (propName) {
                            var provider = _.strLeft(propName, 'Properties');
                            return {
                                key: propName,
                                provider: provider,
                                providerId: user[provider + 'Id'],
                                properties: user[propName]            
                            };
                         });

    return allProperties;
};

// converts the properties object into user identity object returned from user.getIdentities()
UserService.prototype._userPropertiesToIdentity = function (provider, providerId, properties) {
    var claims = properties.claims || {};
    var identity = _.extend(claims, properties.secrets);    
    if (providerId) {
        var userId = _.sprintf('%s:%s', UserService.getProviderNameByKey(provider), providerId);
        identity.userId = userId;
    }
    return identity;
};

UserService.prototype._createUser = function (provider, providerId, properties, callback) {
    var self = this;

    this.userStore.createUser(provider, providerId, properties, function (err, user) {
        if (err) {
            return self._handleStorageError(err, callback);
        }

        callback(null, user);
    });
};

UserService.prototype._addIdentityToUser = function (user, provider, providerId, properties, callback) {
    var self = this,
        idKey = provider + 'Id',
        propertiesKey = provider + 'Properties';

    var modified = user[idKey] !== providerId || user[propertiesKey] !== properties;
    if (!modified) {
        callback(null, user);
        return;
    }

    user[idKey] = providerId.toString();
    user[propertiesKey] = properties;

    this.userStore.updateUser(user, function (err, rowCount) {
        if (err) {
            return self._handleStorageError(err, callback);
        }

        callback(null, user);
    });
};

UserService.prototype._handleStorageError = function (err, callback) {
    this.logger.logUser('', LogType.Error, _.sprintf('Error while accessing users table: %s', err.toString()));
    callback(new Error('Error connecting to user database.'));
};

// implements null object pattern by creating a user service like object that is always disabled. 
Object.defineProperty(UserService, 'nullService', {
    get: function () {
        return {
            isEnabled: function (callback) {
                callback(null, false);
            }
        };
    }
});

// factory method for creating user service instance 
UserService.create = function (options, previewFeatures, metrics, logger) {
    options = options || {};

    var featureEnabled = _.contains(previewFeatures, 'Users');
    if (!featureEnabled) {
        return UserService.nullService;
    }

    var encryptClaims = core.parseBoolean(options.MS_UsersEncryptClaims);
    var dynamicSchemaEnabled = true;
    var storage = new Storage(options.MS_SqlConnectionString, options.MS_MobileServiceName, dynamicSchemaEnabled, logger, metrics, {});
    var userStore = new UserStore(logger, storage);
    var userProperties = new UserProperties(options.MS_MasterKey);
    var userService = new UserService(logger, userStore, userProperties, encryptClaims);

    return userService;
};

// get provider name by provider specific user id issued by zumo
UserService.getProviderNameByUserId = function (userId) {
    return _.strLeft(userId, ':');
};

// returns full name of provider for short code
UserService.getProviderNameByKey = function (key) {
    var name = key.toLowerCase();
    if (name == 'microsoft') {
        name = 'MicrosoftAccount';
    }
    return _.capitalize(name);
};

// derive short code for provider from its full name
UserService.getProviderKeyByName = function (name) {
    var key = name.toLowerCase();
    if (key == 'microsoftaccount') {
        key = 'microsoft';
    }
    return key;
};

exports = module.exports = UserService;