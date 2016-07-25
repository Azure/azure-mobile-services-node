// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

(function (global) {

    var core = require('../core');

    require('../query/expressions');
    require('../query/expressionvisitor');
    require('../query/queryparser');
    require('./sqlhelpers');

    var instanceMembers = {

        visitUnary: function (expr) {
            var operand = this.visit(expr.operand);

            if (operand && expr.expressionType == ExpressionType.Not) {
                // Convert expression 'x' to a boolean expression '(x = true)' since
                // the SQL Not operator requires a boolean expression (not a BIT)
                return new UnaryExpression(ensureExpressionIsBoolean(operand), ExpressionType.Not);
            }

            if (operand != expr.operand) {
                return new UnaryExpression(operand, expr.expressionType);
            }

            return expr;
        },

        visitBinary: function (expr) {
            var left = null;
            var right = null;

            // first visit the expressions to do any sub conversions, before
            // doing any transformations below
            if (expr.left !== null) {
                left = this.visit(expr.left);
            }
            if (expr.right !== null) {
                right = this.visit(expr.right);
            }

            if ((expr.expressionType == ExpressionType.And) || (expr.expressionType == ExpressionType.Or)) {
                // both operands must be boolean expressions
                left = ensureExpressionIsBoolean(left);
                right = ensureExpressionIsBoolean(right);
            }
            else if ((expr.expressionType == ExpressionType.Equal) || (expr.expressionType == ExpressionType.NotEqual)) {
                // remove any comparisons between boolean and bit
                var converted = rewriteBitComparison(left, right);
                if (converted) {
                    return converted;
                }
            }

            if (left != expr.left || right != expr.right) {
                return new BinaryExpression(left, right, expr.expressionType);
            }
           
            return expr;
        }
    };

    // if a boolean expression is being compared to a bit expression, convert
    // by removing the comparison. E.g. (endswith('value', title) eq false) => not(endswith('value', title))
    function rewriteBitComparison(left, right) {
        if (isBooleanExpression(left) && isBitConstantExpression(right)) {
            return (right.value === true) ? left : new UnaryExpression(left, ExpressionType.Not);
        }
        else if (isBooleanExpression(right) && isBitConstantExpression(left)) {
            return (left.value === true) ? right : new UnaryExpression(right, ExpressionType.Not);
        }

        // no conversion necessary
        return null;
    }

    // returns true if the expression is the constant 'true' or 'false'
    function isBitConstantExpression(expr) {
        return (expr.expressionType == ExpressionType.Constant) && (expr.value === true || expr.value === false);
    }

    // if the expression isn't boolean, convert to a boolean expression (e.g. (isDiscontinued) => (isDiscontinued = 1))
    function ensureExpressionIsBoolean(expr) {
        if (!isBooleanExpression(expr)) {
            return new BinaryExpression(expr, new ConstantExpression(true), ExpressionType.Equal);
        }
        return expr;
    }

    function isBooleanExpression(expr) {
        if (!expr) {
            return false;
        }

        // see if this is a logical boolean expression
        switch (expr.expressionType) {
            case ExpressionType.And:
            case ExpressionType.Or:
            case ExpressionType.GreaterThan:
            case ExpressionType.GreaterThanOrEqual:
            case ExpressionType.LessThan:
            case ExpressionType.LessThanOrEqual:
            case ExpressionType.Not:
            case ExpressionType.Equal:
            case ExpressionType.NotEqual:
                return true;
            default:
                break;
        }

        // boolean odata functions
        if (expr.expressionType == ExpressionType.Call) {
            switch (expr.memberInfo.memberName) {
                case 'startswith':
                case 'endswith':
                case 'substringof':
                    return true;
                default:
                    break;
            }
        }

        return false;
    }

    SqlBooleanizer = core.deriveClass(ExpressionVisitor, null, instanceMembers);

    SqlBooleanizer.booleanize = function (expr) {
        var booleanizer = new SqlBooleanizer();

        expr = booleanizer.visit(expr);
        expr = ensureExpressionIsBoolean(expr);

        return expr;
    };

})(typeof exports === "undefined" ? this : exports);