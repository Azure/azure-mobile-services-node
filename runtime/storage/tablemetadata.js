// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------
//
// This class captures the metadata about a table in user database.

var _ = require('underscore'),
    _str = require('underscore.string');
    core = require('../core');

_.mixin(_str.exports());

function TableMetadata () {
    this.idType = 'unknown';
    this.supportsConflict = false;
    this.supportsSoftDelete = false;
    this.systemProperties = [];
    this.binaryColumns = [];

    Object.defineProperty(this, 'hasStringId', {
        get: function () { return this.idType === 'string'; }
    });
}

TableMetadata.prototype.hasBinaryColumn = function (name) {
    return _.contains(this.binaryColumns, name.toLowerCase());
};

TableMetadata.prototype._addColumn = function (column) {
    // check if the column is id
    if (column.name === 'id') {
        this.idType = this._getTableIdType(column.type);
    }

    // check if the column is a system property
    if (core.isSystemColumnName(column.name)) {
        this._addSystemColumn(column);
    }

    // check if the column is a binary data type
    if (column.type === 'binary' || column.type == 'timestamp') {
        this.binaryColumns.push(column.name);
    }
};

TableMetadata.prototype._addSystemColumn = function (column) {
    var name = column.name.substring(2);
    var property = core.getSystemProperty(name);

    if (property && property.type === column.type) {
        this.systemProperties.push(property.name);

        if (property.name == 'version') {
            this.supportsConflict = true;
        }
        else if (property.name == 'deleted') {
            this.supportsSoftDelete = true;
        }
    }
};

TableMetadata.prototype._getTableIdType = function (type) {
    if (type.indexOf('int') >= 0) {
        return 'number';
    }
    else if (type.indexOf('char') >= 0) {
        return 'string';
    }
    return 'unknown';
};

TableMetadata.fromColumns = function (columns) {
    // the default table metadata
    var metadata = new TableMetadata();

    // iterate over the columns 
    _.each(columns, function (column) {
        metadata._addColumn(column);
    });

    if (metadata.idType !== 'string') {
        metadata.systemProperties = [];
        metadata.supportsConflict = false;
        metadata.supportsSoftDelete = false;
    }

    return metadata;
};

exports = module.exports = TableMetadata;