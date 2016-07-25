// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

(function (global) {

    var _ = require('underscore'),
        _str = require('underscore.string'),
        resource = require('../resources'),
        core = require('../core');

    _.mixin(_str.exports());

    // enumeration of the set of sql error codes
    // we have special handling for
    // These map to ODBC error codes (i.e. SQLSTATE)
    SqlErrorCodes = {
        CannotDropTable: '42S02',
        InvalidColumnName: '42S22',
        ColumnNamesMustBeUnique: '42S21',
        LoginFailed: '28000',
        ColumnSizeExceeded: '22001',
        ConstraintViolation: '23000',
        GeneralError: 'HY000',
        InvalidNumber: 'IMNOD'
    };

    // Set of ODBC errors that we consider 'temporary'
    // and candidate for retry. these errors are taken
    // from http://msdn.microsoft.com/en-us/library/ms714687.aspx
    SqlTemporaryErrorCodes = {
        ConnectionForciblyClosed: '08S01',
        UnableToEstablishConnection: '08001',
        ConnectionNotOpen: '08003',
        ServerRejectedConnection: '08004',
        ConnectionTimeoutExpired: 'HYT01',
        TimeoutExpired: 'HYT00'
    };

    // These map to secondary sql error codes (distinct from SQLSTATE)
    SqlErrorNumbers = {
        SqlAzureWorkerThreadsThrottle: 40501,
        SqlAzureWorkerThreadGovernanceThrottle_Level1: 10928,
        SqlAzureWorkerThreadGovernanceThrottle2_Level2: 10929,
        SqlUniqueConstraintViolationError: 2627
    };

    // "Application" error codes are those SQL errors that are not caused by
    // end user input. These errors we'll treat as application errors, logging
    // to user log, etc.
    SqlApplicationErrorCodes = _.extend({
        LoginFailed: SqlErrorCodes.LoginFailed,
        GeneralError: SqlErrorCodes.GeneralError
    }, SqlTemporaryErrorCodes);

    var classMembers = {
        // inspects the specified error (including innerError) and returns
        // the sqlstate if it exists
        getSqlErrorCode: function (err) {
            if (err) {
                return err.innerError ? err.innerError.sqlstate : err.sqlstate;
            }
        },

        // determines whether the specified error is a sql error
        isSqlError: function (err) {
            return err && !!this.getSqlErrorCode(err);
        },

        isThrottleError: function (err) {
            // There are a set of SqlAzure specific throttle errors that we must identify by
            // error number, in addition to the general HY000 sql state they return. These are:
            // http://social.technet.microsoft.com/wiki/contents/articles/1541.windows-azure-sql-database-connection-management.aspx
            return err.sqlstate == 'HY000' &&
                (err.code == SqlErrorNumbers.SqlAzureWorkerThreadsThrottle ||
                err.code == SqlErrorNumbers.SqlAzureWorkerThreadGovernanceThrottle_Level1 ||
                err.code == SqlErrorNumbers.SqlAzureWorkerThreadGovernanceThrottle2_Level2);
        },

        // determines whether the specified sql error
        // has an error code that matches one of our
        // 'retry' codes, indicating that the failed sql
        // operation should be reattempted.
        isTemporaryError: function (err) {
            var errCode = err.sqlstate;
            if (errCode) {
                for (var idx in SqlTemporaryErrorCodes) {
                    if (SqlTemporaryErrorCodes[idx] == errCode) {
                        return true;
                    }
                }

                if (this.isThrottleError(err)) {
                    return true;
                }
            }
            return false;
        },

        // Returns true if the specified sql error is considered to be
        // an application controlled issue. Returns false if the error is
        // likely due to bad input data (e.g. wrong data type, null constraint, etc)
        isApplicationError: function (err) {
            var sqlErrorCode = this.getSqlErrorCode(err);
            if (sqlErrorCode) {
                return _.any(SqlApplicationErrorCodes, function (code) {
                    return sqlErrorCode == code;
                });
            }
            return false;
        },

        // Returns true if the specified sql error should be considered
        // a "system" sql error that we should log to our system log.
        // See here for more info on ODBC status codes: http://msdn.microsoft.com/en-us/library/ms714687.aspx
        isSystemSqlError: function (err) {
            var sqlErrorCode = this.getSqlErrorCode(err);
            if (!sqlErrorCode) {
                return false;
            }

            if (_.startsWith(sqlErrorCode, 'IM') && sqlErrorCode !== SqlErrorCodes.InvalidNumber) {
                // this range of errors are due to lower level driver failures,
                // e.g. IM004 'Driver's SQLAllocHandle on SQL_HANDLE_ENV failed'
                return true;
            }

            return false;
        },

        // Performs the following validations on the specified identifier:
        // - first char is alphabetic or an underscore
        // - all other characters are alphanumeric or underscore
        // - the identifier is LTE 128 in length
        // 
        // When used with proper sql parameterization techniques, this
        // mitigates SQL INJECTION attacks.
        isValidIdentifier: function (identifier) {
            if (!identifier || !core.isString(identifier) || identifier.length > 128) {
                return false;
            }

            for (var i = 0; i < identifier.length; i++) {
                var char = identifier[i];
                if (i === 0) {
                    if (!(core.isLetter(char) || (char == '_'))) {
                        return false;
                    }
                }
                else {
                    if (!(core.isLetter(char) || core.isDigit(char) || (char == '_'))) {
                        return false;
                    }
                }
            }

            return true;
        },

        validateIdentifier: function (identifier) {
            if (!this.isValidIdentifier(identifier)) {
                throw new core.MobileServiceError(_.sprintf(resource.invalidIdentifier, identifier), core.ErrorCodes.BadInput);
            }
        },

        // SECURITY - sql generation relies on these format functions to
        // validate identifiers to mitigate sql injection attacks
        // in the dynamic sql we generate
        formatTableName: function (schemaName, tableName) {
            this.validateIdentifier(schemaName);
            this.validateIdentifier(tableName);
            return _.sprintf('[%s].[%s]', schemaName, tableName);
        },

        formatSchemaName: function (appName) {
            // Hyphens are not supported in schema names
            return appName.replace(/-/g, '_');
        },

        formatMember: function (memberName) {
            this.validateIdentifier(memberName);
            return _.sprintf('[%s]', memberName);
        },

        // map json datatypes to SqlTypes
        getSqlType: function (value) {
            var type = core.classof(value);
            switch (type) {
                case 'string':
                    return "NVARCHAR(MAX)";
                case 'number':
                    return "FLOAT(53)";
                case 'boolean':
                    return "BIT";
                case 'date':
                    return "DATETIMEOFFSET(3)";
                default:
                    throw new core.MobileServiceError(_.sprintf("Unable to map type '%s' to a SQL type.", type), core.ErrorCodes.BadInput);
            }
        }
    };

    SqlHelpers = core.defineClass(null, null, classMembers);

})(typeof exports === "undefined" ? this : exports);
