// ----------------------------------------------------------------------------
// Copyright (c) Microsoft Corporation. All rights reserved.
// ----------------------------------------------------------------------------

(function (global) {

    var core = require('../core');

    require('./expressions');

    var instanceMembers = {
        visit: function (expr) {
            return expr.accept(this);
        },

        visitConstant: function (expr) {
            return expr;
        },

        visitBinary: function (expr) {
            var left = null;
            var right = null;

            if (expr.left !== null) {
                left = this.visit(expr.left);
            }
            if (expr.right !== null) {
                right = this.visit(expr.right);
            }
            if (left != expr.left || right != expr.right) {
                return new BinaryExpression(left, right, expr.expressionType);
            }

            return expr;
        },

        visitUnary: function (expr) {
            var operand = this.visit(expr.operand);
            if (operand != expr.operand) {
                return new UnaryExpression(operand, expr.expressionType);
            }
            return expr;
        },

        visitMember: function (expr) {
            return expr;
        },

        visitParameter: function (expr) {
            return expr;
        },

        visitFunction: function (expr) {
            var updated = false;

            var instance = expr.instance;
            if (expr.instance) {
                instance = this.visit(expr.instance);
                if (instance != expr.instance) {
                    updated = true;
                }
            }

            var args = [expr.args.length],
                i = 0,
                self = this;
            expr.args.forEach(function (arg) {
                var newArg = self.visit(arg);
                args[i++] = arg;
                if (newArg != arg) {
                    updated = true;
                }
            });

            if (updated) {
                return new FunctionCallExpression(instance, expr.memberInfo, args);
            }
            return expr;
        }
    };

    ExpressionVisitor = core.defineClass(null, instanceMembers);

})(typeof exports === "undefined" ? this : exports);