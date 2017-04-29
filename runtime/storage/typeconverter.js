// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

((global => {
    var core = require('../core');
    var _ = require('underscore');

    require('../query/expressions');
    require('../query/expressionvisitor');
    require('../query/queryparser');
    require('./sqlhelpers');

    var ctor = function (tableMetadata) {
        this.tableMetadata = tableMetadata;
    };

    var instanceMembers = {

        visitBinary(expr) {
            var left = expr.left ? this.visit(expr.left) : null;
            var right = expr.right ? this.visit(expr.right) : null;

            if (this._isStringConstant(left) && this._isBinaryMemberAccess(right)) {
                left.value = new Buffer(left.value, 'base64');
            }
            else if (this._isStringConstant(right) && this._isBinaryMemberAccess(left)) {
                right.value = new Buffer(right.value, 'base64');
            }

            if (left != expr.left || right != expr.right) {
                return new BinaryExpression(left, right, expr.expressionType);
            }

            return expr;
        },

        _isStringConstant(expr) {
            return expr &&
                   expr.expressionType === ExpressionType.Constant &&
                   core.isString(expr.value);
        },

        _isBinaryMemberAccess(expr) {
            return expr &&
                   expr.expressionType === ExpressionType.MemberAccess &&
                   core.isString(expr.member) &&
                   _.contains(this.tableMetadata.binaryColumns, expr.member.toLowerCase());
        }
    };

    TypeConverter = core.deriveClass(ExpressionVisitor, ctor, instanceMembers);

    TypeConverter.convertTypes = (expr, tableMetadata) => {
        var converter = new TypeConverter(tableMetadata);

        expr = converter.visit(expr);

        return expr;
    };
}))(typeof exports === "undefined" ? this : exports);