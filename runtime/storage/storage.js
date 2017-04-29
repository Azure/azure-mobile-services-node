// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

var sql = require('sqlserver');

var _ = require('underscore');
var _str = require('underscore.string');
var resource = require('../resources');
var core = require('../core');
var TableMetadata = require('./tablemetadata');

_.mixin(_str.exports());

require('./sqlhelpers');
require('./sqlformatter');
require('../core');

exports = module.exports = Storage;

var logSource = 'Storage';

function Storage(connection, appName, dynamicSchemaEnabled, logger, metrics, options) {
    this.connection = connection;
    this.schemaName = SqlHelpers.formatSchemaName(appName);
    this.globalLogger = logger;
    this.metrics = metrics;
    this.dynamicSchemaEnabled = (dynamicSchemaEnabled === undefined) ? true : dynamicSchemaEnabled;
    this.sql = sql;

    options = options || {};
    this.retryMaxCount = options.retryMaxCount || 3;
    this.retryIntervalMS = options.retryIntervalMS || 4000;    

    this.metadata = {};
}

Storage.prototype.getTableMetadata = function (table, logger, callback) {
    var tableMetadata = this.metadata[table];

    if (tableMetadata) {
        callback(null, tableMetadata);
        return;
    }

    var self = this;
    this._getTableColumns(table, logger, (error, columns) => {
        if (error) {
            callback(error);
            return;
        }

        tableMetadata = TableMetadata.fromColumns(columns);
        
        // table doesn't exist or if there are no columns in it. no need to cache the metadata.
        if (columns.length > 0) {
            self.metadata[table] = tableMetadata;
        }

        callback(null, tableMetadata);
    });
};

Storage.prototype.query = function (query, logger, options, callback) {
    query.systemProperties = this._getSystemPropertiesFromOptions(options);
    query.includeDeleted = options && options.includeDeleted;
    this._query(query, logger, callback);
};

Storage.prototype.insert = function (table, item, logger, options, callback) {
    // item can either be a singleton or a homogeneous array
    // of items to insert in a single batch
    var insertOptions = {
        table,
        item,
        logger,
        retry: this.dynamicSchemaEnabled,
        systemProperties: this._getSystemPropertiesFromOptions(options)
    };

    this._insert(insertOptions, callback);
};

Storage.prototype.update = function (table, id, item, logger, options, callback) {
    var self = this;
    this._validateId(table, id, logger, error => {
        if (error) {
            callback(error);
            return;
        }

        var keyCount = item === null ? 0 : Object.keys(item).length;
        if (keyCount === 0) {
            callback(new core.MobileServiceError('One or more update values must be specified.', core.ErrorCodes.BadInput), 0);
            return;
        } else if (keyCount === 1 && item.id !== undefined) {
            // Nothing to update. Return 1 to indicate noop success
            callback(null, 1);
            return;
        }

        var updateOptions = {
            table,
            id,
            item,
            logger,
            retry: self.dynamicSchemaEnabled,
            systemProperties: self._getSystemPropertiesFromOptions(options)
        };

        self._update(updateOptions, callback);
    });
};

Storage.prototype.del = function (table, id, version, logger, options, callback) {
    var self = this;
    this._validateId(table, id, logger, error => {
        if (error) {
            callback(error);
            return;
        }

        self._del(table, id, version, logger, callback);
    });
};

Storage.prototype._getTableMetadataAndSupportedSystemProperties = function (table, systemProperties, logger, callback) {
    // validate the requested system properties
    var wasStar = core.isStarSystemProperty(systemProperties);
    try {
        systemProperties = core.validateAndNormalizeSystemProperties(systemProperties);
    }
    catch (error) {
        callback(error);
        return;
    }

    // get the table metadata
    var self = this;
    this.getTableMetadata(table, logger, (error, tableMetadata) => {
        if (error) {
            callback(error);
            return;
        }

        // check that only supported system properties are being requested
        var supportedSystemProperties = [];
        if (tableMetadata && tableMetadata.hasStringId) {
            systemProperties.forEach(property => {
                if (_.contains(tableMetadata.systemProperties, property)) {
                    supportedSystemProperties.push(property);
                }
                else if (!wasStar) { // only log the warning if the system property was explicitly asked for
                    logger.logUser(logSource, LogType.Warning, _.sprintf("The table '%s' does not support the '%s' system property.", table, property));
                }
            });
        }

        callback(null, supportedSystemProperties, tableMetadata);
    });
};

Storage.prototype._clearTableMetadata = function (table) {
    this.metadata[table] = null;
};

Storage.prototype._getSystemPropertiesFromOptions = options => {
    var systemProperties = options ? options.systemProperties || [] : [];
    return systemProperties;
};

Storage.prototype._validateProperty = (propertyName, value) => {
    // property name must be a valid identifier
    SqlHelpers.validateIdentifier(propertyName);

    // if there is a system property, make sure it is cased correctly
    var systemColumnName = _.find(core.supportedSystemColumns, c => c.toLowerCase() === propertyName);
    if (systemColumnName && propertyName !== systemColumnName) {
        throw new core.MobileServiceError(_.sprintf("If a value for the property '%s' is specified, the property name must be cased correctly.", systemColumn), core.ErrorCodes.BadInput);
    }

    // the value must be of a supported type
    core.validatePropertyType(propertyName, value);
};

Storage.prototype._updateSchema = function (table, item, logger, callback) {
    var self = this;

    this.metrics.event('sql.schematize');

    var retryCount = 0;
    function tryUpdateSchema() {
        self._getColumnsToAdd(table, item, logger, (err, cols) => {
            if (err) {
                callback(err);
                return;
            }

            if (cols.length === 0) {
                // No columns to add so return. This might happen in cases where
                // schematization is happening concurrently
                callback(null);
                return;
            }

            // generate the add column(s) sql
            // note - we've already validated these identifiers in the original create,
            // so we don't need to do so again here
            var addColumnsSql = '';
            var columnsToAddError = null;
            cols.forEach(col => {
                if (core.isSystemColumnName(col) &&
                    self.metadata[table].hasStringId) {
                    columnsToAddError = new core.MobileServiceError(_.sprintf("The column '%s' can not be dynamically added. Columns that begin with a '__' are considered system columns.", col), core.ErrorCodes.BadInput);
                }
                if (addColumnsSql.length > 0) {
                    addColumnsSql += ', ';
                }
                addColumnsSql += _.sprintf("[%s] %s NULL", col, SqlHelpers.getSqlType(item[col]));
            });

            if (columnsToAddError) {
                callback(columnsToAddError);
                return;
            }

            // update the schema
            var tableName = SqlHelpers.formatTableName(self.schemaName, table);
            var cmdText = _.sprintf("ALTER TABLE %s ADD %s;", tableName, addColumnsSql);
            logger.trace(logSource, 'Updating schema', 'SQL: ' + cmdText);

            self._executeSql('ALTER', cmdText, null, logger, null, callback, err => {
                if (!err) {
                    logger.trace(logSource, 'Schema update succeeded.');
                    callback(null);
                }
                else {
                    if (err.sqlstate === SqlErrorCodes.ColumnNamesMustBeUnique && (retryCount < 1)) {
                        // if we've failed to reschematize due to recoverable errors,
                        // retry the schema update, up to the max number of retries (currently
                        // we retry only once).
                        retryCount += 1;
                        logger.trace(logSource, 'Schema update failed - retrying.');
                        tryUpdateSchema();
                    }
                    else {
                        logger.trace(logSource, 'Schema update failed. ' + err.toString());
                        callback(err);
                    }
                }
            });
        });
    }

    tryUpdateSchema();
};

Storage.prototype._getTableColumns = function (table, logger, callback) {
    var statement = _.sprintf("SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '%s' AND TABLE_SCHEMA = '%s'", table, this.schemaName);

    var self = this;
    this._executeSql('SELECT', statement, null, logger, null, callback, (error, results) => {
        if (error) {
            callback(error);
            return;
        }

        var columns = [];
        for (var index in results) {
            var columnInfo = {
                name: results[index].COLUMN_NAME.toLowerCase(),
                type: results[index].DATA_TYPE
            };
            columns.push(columnInfo);
        }

        callback(null, columns);
    });
};

Storage.prototype._getColumnsToAdd = function (table, item, logger, callback) {
    var self = this;
    this._getTableColumns(table, logger, (error, results) => {
        if (error) {
            callback(error);
            return;
        }

        var tableMetadata = TableMetadata.fromColumns(results);
        self.metadata[table] = tableMetadata;

        var existingColumnNames = [];
        for (var index in results) {
            existingColumnNames.push(results[index].name);
        }

        var columns = [];
        for (var property in item) {
            if (existingColumnNames.indexOf(property.toLowerCase()) > -1) {
                // Skip columns that already exist, ensuring that we do a case
                // insensitive comparison on column name
                continue;
            }

            var value = item[property];
            if (value === null) {
                callback(new core.MobileServiceError(_.sprintf("Unable to insert a null value for new property '%s'", property), core.ErrorCodes.BadInput));
                return;
            }

            columns.push(property);
        }

        callback(null, columns);
    });
};

Storage.prototype._update = function (options, callback) {
    var table = options.table;
    var systemProperties = options.systemProperties;
    var logger = options.logger;
    var item = options.item;
    var updateStatement = options.updateStatement;
    var parameters = options.parameters;
    var self = this;

    if (item.__version) {
        item.__version = core.normalizeVersion(item.__version);
    }

    this._getTableMetadataAndSupportedSystemProperties(table, systemProperties, logger, (error, systemProperties, tableMetadata) => {
        if (error) {
            callback(error);
            return;
        }

        if (updateStatement) {
            // update statement is already prepared, this is probably a retry of previously failed update due to dynamic schema handling in _handleUpdateError
            self._executeSqlUpdate(options, callback);
        }
        else {
            // we are building the update statement for the first time
            self._buildSqlUpdate(options, tableMetadata, systemProperties, (error, updateStatement, parameters, version) => {
                if (error) {
                    callback(error);
                    return;
                }

                options.updateStatement = updateStatement;
                options.parameters = parameters;
                options.systemProperties = systemProperties;

                if (version) {
                    options.version = version;
                }

                self._executeSqlUpdate(options, callback);
            });
        }
    });
};

Storage.prototype._executeSqlUpdate = function (options, callback) {
    var self = this;
    var table = options.table;
    var id = options.id;
    var systemProperties = options.systemProperties;
    var logger = options.logger;
    var item = options.item;
    var version = options.version;
    var updateRowCount = 0;
    var updateStatement = options.updateStatement;
    var parameters = options.parameters;
    var lastResult = null;

    logger.trace(logSource, 'Executing update', 'SQL: ' + updateStatement);

    this._executeSql('UPDATE', updateStatement, parameters, logger, null, callback, (error, results, more, rowCount) => {
        if (error) {
            self._handleUpdateError(error, options, logger, callback);
            return;
        }

        // The row count should always be 1 since the update is based on the primary key
        // but this callback might be invoked multiple times, and the rowCount is in any one of them
        var isRowCountResult = results.length === 1 &&
                               typeof results[0].__rowcount !== 'undefined' &&
                               Object.keys(results[0]).length == 1;

        if (isRowCountResult) {
            updateRowCount = results[0].__rowcount;
        }
        else {
            lastResult = results;
        }

        if (!more) {
            // if update fails then we want to detect if the row was soft deleted
            var isUndelete = item.__deleted === false;

            if ((!version && isUndelete) || updateRowCount > 0) {
                self._handleUpdateSuccess(updateRowCount, item, lastResult, logger, callback);
                return;
            }
            // find the row to see if version mismatch occured or the record was soft deleted
            self._handleUpdateOrDeleteFailure(logger, table, item, callback, 'update');
        }
    });
};

// when update or delete statement affects 0 records this method checks to see if the version check failed or the record does not exist
Storage.prototype._handleUpdateOrDeleteFailure = function (logger, table, item, callback, forOperation) {

    this._readItemForError(logger, table, item.id, (error, result) => {
        if (error || !result) {
            callback(error, result);
            return;
        }
        // compare the version just to be sure
        if (item.__version !== result.__version) {
            callback(new core.MobileServiceError(result, core.ErrorCodes.MergeConflict));
        }
        else if (result.__deleted) {
            callback(new core.MobileServiceError(_.sprintf(resource.itemNotFound, item.id), core.ErrorCodes.ItemSoftDeleted));
        }
        else { // this is not even possible if a record exists and version matched affected records should not have been 0
            logger.trace(logSource, 'Record found with same id and version but update or delete failed.');
            callback(null, 0);
        }
    },  _.sprintf('Select for %s with version check failed. ', forOperation) + '%s');    
};

Storage.prototype._readItemForError = function (logger, table, id, callback, readErrorFormat) {
    var query = {
        table,
        id
    };

    var queryOptions = { systemProperties: ['*'], includeDeleted: true };

    this.query(query, logger, queryOptions, (error, results) => {
        if (error) {
            logger.trace(logSource, _.sprintf(readErrorFormat, error.toString()));
            if (callback) {
                callback(new core.MobileServiceError(error));
            }
            return;
        }

        // if there is a record with matching id then likely the version check failed
        if (results && results.length > 0) {
            var result = results[0];
            callback(null, result);
        }
        else {
            callback(null, 0); // no results so the record probably doesn't even exist
        }
    });
};

Storage.prototype._buildSqlUpdate = function (options, tableMetadata, systemProperties, callback) {
    var table = options.table;
    var item = options.item;
    var logger = options.logger;
    var id = options.id;
    var tableName = SqlHelpers.formatTableName(this.schemaName, table);
    var setStatements = '';
    var selectItemProperties = '';
    var versionValue = '';
    var hasStringId = tableMetadata.hasStringId;
    var updateStmt = '';
    var binaryColumns = tableMetadata.binaryColumns;
    var parameters = [];

    for (var prop in item) {
        var value = item[prop];

        if (hasStringId && prop.toLowerCase() === '__version') {
            if (selectItemProperties.length > 0) {
                selectItemProperties += ', ';
            }
            selectItemProperties += _.sprintf('[%1$s] AS [%1$s]', prop);
            versionValue = value;
            continue;
        }

        if (prop.toLowerCase() == 'id') {
            // we skip this property, since the id pk cannot
            // be updated
            continue;
        }

        try {
            this._validateProperty(prop, value);
        }
        catch (error) {
            callback(error);
            return;
        }

        if (setStatements.length > 0) {
            setStatements += ', ';
        }
        setStatements += '[' + prop + '] = ?';

        // Check for binary data that needs to be
        // converted into a buffer instance
        if (_.contains(binaryColumns, prop.toLowerCase()) &&
            core.isString(value)) {
            value = new Buffer(value, 'base64');
        }

        parameters.push(value);
    }

    if (setStatements.length > 0) {
        updateStmt = _.sprintf("UPDATE %s SET %s WHERE [id] = ? ", tableName, setStatements);
    }
    else {
        updateStmt = _.sprintf("UPDATE %s SET [id] = ? WHERE [id] = ? ", tableName, setStatements);
        parameters.push(id);
    }
    parameters.push(id);

    if (versionValue) {
        updateStmt += "AND [__version] = ? ";
        if (!this._trySetVersionParameter(versionValue, parameters, callback))
        {
            return;
        }
    }

    // filter out deleted rows unless we want to undelete the item
    var isUndelete = item.__deleted === false;
    if (tableMetadata.supportsSoftDelete && !isUndelete) {
        updateStmt += "AND [__deleted] = 0 ";
    }

    updateStmt += '; SELECT @@rowcount as __rowcount';

    // Add the SELECT clause if the id is a string
    if (hasStringId) {
        if (systemProperties) {
            _.each(systemProperties, systemProperty => {
                if (!versionValue || systemProperty !== 'version') {
                    if (selectItemProperties.length > 0) {
                        selectItemProperties += ', ';
                    }
                    selectItemProperties += _.sprintf('[__%1$s] AS [__%1$s]', systemProperty);
                }
            });
        }
        if (selectItemProperties.length > 0) {
            updateStmt += _.sprintf("; SELECT %s FROM %s WHERE [id] = ?", selectItemProperties, tableName);
            parameters.push(id);
        }
    }

    callback(null, updateStmt, parameters, versionValue);
};

Storage.prototype._trySetVersionParameter = (version, parameters, callback) => {
    var versionBuffer = null;
    try {
        versionBuffer = new Buffer(version, 'base64');
    }
    catch (e) {
        callback(new core.MobileServiceError('The version must be a base64 string.', core.ErrorCodes.BadInput));
        return false;
    }
    parameters.push(versionBuffer);
    return true;
};

Storage.prototype._handleUpdateSuccess = (updateRowCount, item, results, logger, callback) => {
    logger.trace(logSource, 'Update completed successfully. Rows affected: ' + updateRowCount);

    if (callback) {
        if (results && results.length > 0) {
            core.extend(item, results[0]);
        }

        callback(null, updateRowCount);
    }
};

Storage.prototype._handleUpdateError = function (error, options, logger, callback) {
    logger.trace(logSource, 'Update failed. ' + error.toString());

    if (callback) {
        var isInvalidColumnSqlError = error.sqlstate === SqlErrorCodes.InvalidColumnName;
        if (options.retry && isInvalidColumnSqlError) {
            this._retryUpdate(options, callback);
        }
        else if (!this.dynamicSchemaEnabled && isInvalidColumnSqlError) {
            callback(new core.MobileServiceError(resource.colNotInSchema, core.ErrorCodes.BadInput));
        }
        else if (error.sqlstate === SqlErrorCodes.ColumnSizeExceeded) {
            callback(new core.MobileServiceError(resource.maxColSizeExceeded, core.ErrorCodes.BadInput));
        }
        else {
            callback(new core.MobileServiceError(error));
        }
    }
};

Storage.prototype._retryUpdate = function (options, callback) {
    var self = this;
    this._updateSchema(options.table, options.item, options.logger, error => {
        if (error) {
            callback(error);
            return;
        }

        // the schema update succeeded, so retry the update
        options.retry = false;
        self._update(options, callback);
    });
};

Storage.prototype._del = function (table, id, version, logger, callback) {
    var parameters = [];
    var item = { id, __version: version };
    var tableName = SqlHelpers.formatTableName(this.schemaName, table);
    var deleteStmt = _.sprintf("DELETE FROM %s WHERE [id] = ?", tableName);
    var sqlEventName = 'DELETE';
    var forOperation = 'delete';
    var errorPrefix = 'Delete';
    var self = this;
    parameters.push(id);

    this.getTableMetadata(table, logger, (error, tableMetadata) => {
        if (error) {
            callback(error);
            return;
        }

        if (tableMetadata.supportsSoftDelete) {
            deleteStmt = _.sprintf("UPDATE TOP (1) %s SET [__deleted] = 1 WHERE [id] = ? AND [__deleted] = 0", tableName);
            sqlEventName = 'UPDATE';
            forOperation = 'update';
            errorPrefix = 'Soft delete';
        }

        if (version) {
            deleteStmt += " AND [__version] = ? ";

            if (!self._trySetVersionParameter(version, parameters, callback)) {
                return;
            }
        }

        logger.trace(logSource, 'Executing delete', 'SQL: ' + deleteStmt);
        
        var deleteRowCount = 0;
        self._executeSql(sqlEventName, deleteStmt, parameters, logger, null, callback, (err, results, more, rowCount) => {
            if (!err) {
                // The row count should always be 1 since the delete is based on the primary key
                // but this callback mught be invoked multiple times, and the rowCount might be set on
                // either invocation.
                if (rowCount > deleteRowCount) {
                    deleteRowCount = rowCount;
                }

                if (!more) {
                    if (!version || deleteRowCount > 0) {
                        logger.trace(logSource, _.sprintf('%s completed successfully. Rows affected: %d', errorPrefix, deleteRowCount));
                        if (callback) {
                            callback(null, deleteRowCount);
                        }
                        return;
                    }

                    self._handleUpdateOrDeleteFailure(logger, table, item, callback, forOperation);
                }
            }
            else {
                logger.trace(logSource, _.sprintf('%s failed. %s', errorPrefix, err.toString()));
                if (callback) {
                    callback(new core.MobileServiceError(err));
                }
            }
        });
    });
};

Storage.prototype._insert = function (options, callback) {
    var table = options.table;
    var systemProperties = options.systemProperties;
    var logger = options.logger;
    var item = options.item;
    var insertStatement = options.insertStatement;
    var parameters = options.parameters;
    var self = this;

    this._getTableMetadataAndSupportedSystemProperties(table, systemProperties, logger, (error, systemProperties, tableMetadata) => {
        if (error) {
            callback(error);
            return;
        }

        if (insertStatement) {
            // this is a retry, sql already built
            self._executeSqlInsert(options, callback);
        }
        else {
            // we are building the insert statement for the first time
            self._buildSqlInsert(table, item, tableMetadata, systemProperties, logger, (error, insertStatement, parameters) => {
                if (error) {
                    callback(error);
                    return;
                }

                options.insertStatement = insertStatement;
                options.parameters = parameters;
                options.systemProperties = systemProperties;

                self._executeSqlInsert(options, callback);
            });
        }
    });
};

Storage.prototype._executeSqlInsert = function (options, callback) {
    var self = this;
    var logger = options.logger;
    var item = options.item;
    var insertStatement = options.insertStatement;
    var parameters = options.parameters;

    logger.trace(logSource, 'Executing insert', 'SQL: ' + insertStatement);

    this._executeSql('INSERT', insertStatement, parameters, logger, null, callback, (error, results, more) => {
        if (error) {            
            self._handleInsertError(error, options, logger, callback);
            return;
        }

        if (!more) {
            self._handleInsertSuccess(item, results, logger, callback);
        }
    });
};

Storage.prototype._buildSqlInsert = function (table, item, tableMetadata, systemProperties, logger, callback) {
    var parameters = [];
    var hasStringId = tableMetadata.hasStringId;
    var binaryColumns = tableMetadata.binaryColumns;
    var tableName = SqlHelpers.formatTableName(this.schemaName, table);
    var self = this;
    var invalidIdError = null;
    var columnNames = '';
    var valueParams = '';

    _.each(item, (value, prop) => {
        if (!invalidIdError) {
            // validate the property
            try {
                self._validateProperty(prop, value);
            }
            catch (error) {
                invalidIdError = error;
            }

            if (prop === 'id' && value) {
                if (!hasStringId) {
                    invalidIdError = new core.MobileServiceError(resource.intIdValueNotAllowedOnInsert, core.ErrorCodes.BadInput);
                }
                else if (!core.isValidStringId(value)) {
                    invalidIdError = new core.MobileServiceError("The value specified for property 'id' is invalid. An id must not contain any control characters or the characters \",+,?,\\,`.", core.ErrorCodes.BadInput);
                    return;
                }
            }

            // ignore the property if it is a default id
            if (prop !== 'id' || value) {
                // get the column names and values
                if (columnNames.length > 0) {
                    columnNames += ', ';
                }
                columnNames += '[' + prop + ']';

                if (valueParams.length > 0) {
                    valueParams += ', ';
                }
                valueParams += '?';

                // Check for binary data that needs to be
                // converted into a buffer instance
                if (_.contains(binaryColumns, prop.toLowerCase()) &&
                        core.isString(value)) {
                    value = new Buffer(value, 'base64');
                }

                parameters.push(value);
            }
        }
    });


    if (invalidIdError) {
        callback(invalidIdError);
        return;
    }

    // to select the inserted row's id we need to use OUTPUT clause and for a table with triggers OUTPUT INTO is required so we need a temp table
    var insertStmt = _.sprintf('DECLARE  @temp table(id %s) ', hasStringId ? 'nvarchar(MAX)' : 'bigint');

    // Create the VALUES clause and add the INSERT clause
    var valuesClause;
    if (columnNames.length > 0) {
        valuesClause = _.sprintf(" VALUES (%s) ", valueParams);
        insertStmt += _.sprintf("INSERT INTO %s (%s)", tableName, columnNames);
    }
    else {
        // no values being inserted, so insert defaults
        valuesClause = " DEFAULT VALUES ";
        insertStmt += _.sprintf("INSERT INTO %s ", tableName);
    }

    // Add the OUTPUT clause
    var outputClause = ' OUTPUT INSERTED.id INTO @temp';

    insertStmt += outputClause + valuesClause;

    if (hasStringId) {
        var selectItemProperties = '[appTable].[id] AS [id]';
        if (systemProperties) {
            systemProperties.forEach(systemProperty => {
                selectItemProperties += _.sprintf(', [appTable].[__%1$s] AS [__%1$s]', systemProperty);
            });
        }
        // select the system properties and generated ids for the rows from data added to temp table using output clause
        insertStmt += _.sprintf('SELECT %s FROM %s AS appTable INNER JOIN @temp AS temp ON [appTable].[id] = [temp].[id] ', selectItemProperties, tableName);
    }
    else {
        insertStmt += 'SELECT id from @temp';
    }

    callback(null, insertStmt, parameters);
};

Storage.prototype._handleInsertSuccess = (item, results, logger, callback) => {
    logger.trace(logSource, 'Insert completed successfully.');

    if (callback) {
        var result = results[0];
        core.extend(item, result);
        callback(null, item);
    }
};

Storage.prototype._handleInsertError = function (error, options, logger, callback) {
    logger.trace(logSource, 'Insert failed. ' + error.toString());    
    if (callback) {
        var isInvalidColumnSqlError = error.sqlstate === SqlErrorCodes.InvalidColumnName;
        if (options.retry && isInvalidColumnSqlError) {
            this._retryInsert(options, callback);
        }
        else if (!this.dynamicSchemaEnabled && isInvalidColumnSqlError) {
            callback(new core.MobileServiceError(resource.colNotInSchema, core.ErrorCodes.BadInput));
        }
        else if (error.sqlstate === SqlErrorCodes.ColumnSizeExceeded) {
            callback(new core.MobileServiceError(resource.maxColSizeExceeded, core.ErrorCodes.BadInput));
        }
        else if (error.sqlstate === SqlErrorCodes.ConstraintViolation && error.code === SqlErrorNumbers.SqlUniqueConstraintViolationError) {
            callback(new core.MobileServiceError(resource.itemWithIdAlreadyExists, core.ErrorCodes.Conflict));
        } else {
            callback(new core.MobileServiceError(error));
        }
    }
};

Storage.prototype._retryInsert = function (options, callback) {
    var self = this;

    // if we have an item array, reschematize based on the first item.
    // this of course assumes homogenous arrays
    var item = core.isArray(options.item) ? options.item[0] : options.item;

    this._updateSchema(options.table, item, options.logger, err => {
        if (!err) {
            // the schema update succeeded, so retry the insert
            options.retry = false;
            self._insert(options, callback);
        }
        else if (callback) {
            callback(err);
        }
    });
};

Storage.prototype._query = function (query, logger, callback) {
    // ensure only supported system properties are being requested
    var self = this;
    this._getTableMetadataAndSupportedSystemProperties(query.table, query.systemProperties, logger, (error, systemProperties, tableMetadata) => {
        if (error) {
            callback(error);
            return;
        }

        query.systemProperties = systemProperties;
        
        self._buildSqlQuery(query, tableMetadata, (error, sqlStatement, parameters) => {
            if (error) {
                callback(error);
                return;
            }

            logger.trace(logSource, 'Executing query', 'SQL: ' + sqlStatement);

            var allResults = [];
            self._executeSql('SELECT', sqlStatement, parameters, logger, null, callback, (error, results, more) => {
                if (error) {
                    self._handleQueryError(query, error, logger, callback);
                }
                else {
                    // accumulate a collection of results if $inlinecount was requested
                    allResults.push(results);
                    if (!more) {
                        self._handleQuerySuccess(query, allResults, tableMetadata, logger, callback);
                    }
                }
            });
        });
    });
};

Storage.prototype._buildSqlQuery = function (query, tableMetadata, callback) {
    // SQL format the query
    var formatter = new SqlFormatter(this.schemaName, tableMetadata);
    try {
        formatter.format(query);
    }
    catch (error) {
        callback(new core.MobileServiceError('Invalid query specified. ' + error, core.ErrorCodes.BadInput));
        return;
    }

    // build the parameter values array
    var parameters = [];
    _.each(formatter.parameters, parameter => {
        parameters.push(parameter.value);
    });

    callback(null, formatter.sql, parameters);
};

Storage.prototype._handleQueryError = function (query, error, logger, callback) {
    logger.trace(logSource, 'Query failed. ' + error.toString());
         
    if (callback) {
        var isInvalidColumnSqlError = error.sqlstate === SqlErrorCodes.InvalidColumnName;

        if (this.dynamicSchemaEnabled && isInvalidColumnSqlError) {
            // if dynamic schema is enabled and the query failed due to an invalid column
            // name, return an empty result set
            callback(null, []);
        }
        else if (!this.dynamicSchemaEnabled && isInvalidColumnSqlError) {
            callback(new core.MobileServiceError("Invalid column name specified in query.", core.ErrorCodes.BadInput));
        }
        else {
            callback(new core.MobileServiceError(error));
        }
    }
};

Storage.prototype._getSystemPropertiesToDeleteFromQueryResults = (query, tableMetadata) => {
    // get a normalized (trimmed, all lowercase) list of the select properties
    var selectedProperties = [];
    if (query.select) {
        query.select.split(',').forEach(selectedProperty => {
            selectedProperty = selectedProperty.trim();
            if (selectedProperty.length > 0) {
                selectedProperty = selectedProperty.toLowerCase();
                selectedProperties.push(selectedProperty);
            }
        });
    }

    var systemPropertiesToDelete = [];
    tableMetadata.systemProperties.forEach(systemProperty => {
        // don't delete any requested system properties
        if (!_.contains(query.systemProperties, systemProperty)) {
            var columnName = core.systemPropertyToColumnName(systemProperty.toLowerCase());

            // also don't delete any selected properties
            if (!_.contains(selectedProperties, columnName)) {
                systemPropertiesToDelete.push(columnName);
            }
        }
    });

    return systemPropertiesToDelete;
};

Storage.prototype._handleQuerySuccess = function (query, results, tableMetadata, logger, callback) {
    if (callback) {
        // if there is a second result set, it is an inline count result
        var queryResult = results[0];

        // determine if any system properties were returned that need to be deleted
        var systemPropertiesToDelete = this._getSystemPropertiesToDeleteFromQueryResults(query, tableMetadata);

        // determine if the query was paged
        var pagedQuery = query.skip >= 0 && query.top >= 0;

        // iterate through the results to remove row numbers or system properties
        // that were not requested
        if (pagedQuery || systemPropertiesToDelete.length > 0) {
            _.each(queryResult, result => {
                // delete the row numbers if the query was paged
                if (pagedQuery) {
                    delete result.ROW_NUMBER;
                }

                // delete the system property if it wasn't requested
                _.each(_.keys(result), property => {
                    if (_.contains(systemPropertiesToDelete, property.toLowerCase())) {
                        delete result[property];
                    }
                });
            });
        }

        // check if total count was requested
        if (results.length > 1) {
            queryResult = {
                results: queryResult,
                count: results[1][0].count  // second result set, first record, count property
            };
        }

        var count = queryResult.results ? queryResult.results.length : queryResult.length;
        logger.trace(logSource, _.sprintf("Query completed successfully (Result count: %d).", count));

        callback(null, queryResult);
    }
};

// Intended to only be called for unhandled errors that have been caught
Storage.prototype._handleSystemError = (error, logger, callback) => {
    if (core.isRuntimeError(error)) {
        logger.error(logSource, error);
    }
    else {
        logger.logUser('', LogType.Error, error);
    }

    if (callback) {
        callback(error);
    }
};

Storage.prototype._validateId = function (table, id, logger, callback) {
    this.getTableMetadata(table, logger, (error, tableMetadata) => {
        var idType = tableMetadata.idType;
        error = null;
        if (!id ||
            (idType === "number" && !core.isNumber(id)) ||
            (idType === "string" && !core.isString(id)) ||
             idType === "unknown") {
            error = new core.MobileServiceError('Invalid id value specified.', core.ErrorCodes.BadInput);
        }

        callback(error);
    });
};

// Options parameter format: 
// var options = { 
//    disableUserLog: true|false
// }
Storage.prototype.executeSql = function (sqlEventName, sqlStmt, parameters, logger, options, callback) {
    try {
        this._executeSql(sqlEventName, sqlStmt, parameters, logger, options, err => {
            callback(err);
        }, callback);
    }
    catch (e) {
        this._handleSystemError(e, logger, callback);
    }
};

// Execute sql with error handling, and retry logic, wrapping the sql callback code with exception
// handling so we can catch and log any errors
Storage.prototype._executeSql = function (sqlEventName, sqlStmt, parameters, logger, options, callback, sqlCallback) {
    options = options || {};

    var self = this;
    var rowCount;
    var retryCount = 0;
    var disableUserLog = options.disableUserLog || false;

    // to facilitate retries, define a function that will actually execute the sql
    function executeSql() {
        try {
            var event = self.metrics.startEvent('sql.command.' + sqlEventName);
            var stmt = self.sql.query(self.connection, sqlStmt, parameters, (err, results, more) => {
                self.metrics.endEvent(event);

                if (err) {
                    self.metrics.event('sql.error.' + err.sqlstate);

                    // apply the sql state and code to the error message - the sql node driver doesn't
                    // include this by default.
                    err.message = _.sprintf('%s (SqlState: %s, Code: %s)', err.message, err.sqlstate, err.code);

                    // determine if the error should be logged to our system log
                    if (SqlHelpers.isSystemSqlError(err)) {
                        logger.error(logSource, err);
                    }

                    if (SqlHelpers.isTemporaryError(err) && (retryCount++ < self.retryMaxCount)) {
                        // an error occurred for which we'll retry the sql again
                        logger.log(LogLevel.Warning, LogType.Warning, logSource,
                        _.sprintf("SQL statement failed with temporary error '%s'. Retrying.", err), { sql: sqlStmt, retry: retryCount });

                        // if this was a SQL throttle, log a warning to the user log
                        if (!disableUserLog && SqlHelpers.isThrottleError(err)) {
                            err.message = _.sprintf('Retrying request due to SQL throttle reached. %s', err.message);
                            logger.logUser('', LogType.Warning, err);
                        }

                        // retry the sql after the timeout elapses
                        _.delay(executeSql, self.retryIntervalMS);
                    } else {
                        if (!disableUserLog && SqlHelpers.isTemporaryError(err)) {
                            // we've failed after exhausting all retries so log to user log
                            self.metrics.event('sql.error.failedAfterRetries.' + err.sqlstate);
                            err.message = _.sprintf("SQL failure after %d attempts. %s", self.retryMaxCount, err);
                            logger.logUser('', LogType.Error, err);
                        }

                        sqlCallback(err, results, more, rowCount);
                    }
                } else {
                    self.metrics.event('sql.success');
                    sqlCallback(err, results, more, rowCount);
                }
            });

            if (stmt) {
                stmt.on('rowcount', result => {
                    rowCount = result;
                });
            }
        }
        catch (error) {
            if (error.sqlstate) {
                self.metrics.event('sql.error.' + error.sqlstate);
            }
            self._handleSystemError(error, logger, callback);
        }   
    }

    executeSql();
};
