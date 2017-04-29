// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This class encapsulates the queries to users storage

var tableName = "__users";

function UserStore(logger, storage) {
    this.enabled = storage ? undefined : false;
    this.storage = storage;
    this.logger = logger;
}

UserStore.TableNotFoundError = '__users table not found.';

// checks if __users table exists in the database
UserStore.prototype.isEnabled = function (callback) {
    var self = this;

    if (this.enabled === undefined) {
        var query = {
            table: tableName,
            select: 'id',
            top: 1
        };

        this.storage.query(query, this.logger, null, (err, results) => {
            var tableNotFoundError = self._isTableNotFoundError(err);
            // if it is an error but not the expected table found error then we're not able to determine at this time whether users feature is enabled or not
            if (err && !tableNotFoundError) {
                callback(err);
            }
            else {
                // enabled if we didn't get the error, disabled if we get table not found error
                self.enabled = !tableNotFoundError;
                callback(null, self.enabled);
            }
        });
    }
    else {
        callback(null, this.enabled);
    }
};

// get user by 3rd party identity provider specific user id
UserStore.prototype.getUserByProviderId = function (provider, providerId, callback) {
    var self = this;

    var query = {
        table: tableName,
        filter: provider + "Id eq '" + providerId + "'"
    };

    this.storage.query(query, this.logger, null, (err, results) => {
        if (err) {
            self._callErrorCallback(err, callback);
            return;
        }

        if (results.length === 0) {
            callback(null, null);
        }
        else {
            callback(null, results[0]);                
        }
    });
};

// update existing user in the stroage
UserStore.prototype.updateUser = function (user, callback) {
    var self = this;

    this.storage.update(tableName, user.id, user, this.logger, null, (err, rowCount) => {
        if (err) {
            self._callErrorCallback(err, callback);
            return;
        }

        callback(null, rowCount);
    });
};

// create new user in the storage
UserStore.prototype.createUser = function (provider, providerId, providerProperties, callback) {
    var self = this;
    var user = {};

    user[provider + 'Id'] = providerId;
    user[provider + 'Properties'] = providerProperties;

    this.storage.insert(tableName, user, this.logger, null, (err, insertedUser) => {
        if (err) {
            self._callErrorCallback(err, callback);
            return;
        }

        callback(null, insertedUser);
    });
};

// get user by unique id
UserStore.prototype.getUserById = function (userId, callback) {
    var self = this;

    var query = {
        table: tableName,
        filter: "id eq '" + userId + "'",
        top: 1
    };

    this.storage.query(query, this.logger, null, (err, results) => {
        if (err) {
            self._callErrorCallback(err, callback);
            return;
        }

        callback(null, results[0]);
    });
};

UserStore.prototype._callErrorCallback = function (err, callback) {
    if (this._isTableNotFoundError(err)) {
        this.enabled = false;
        callback(new Error(UserStore.TableNotFoundError));
    } else {
        callback(err);
    }
};

UserStore.prototype._isTableNotFoundError = err => {
    var isTableNotFound = err &&
                          err.innerError &&
                          err.innerError.sqlstate === '42S02' &&
                          err.innerError.code === 208;

    return isTableNotFound;
};

exports = module.exports = UserStore;