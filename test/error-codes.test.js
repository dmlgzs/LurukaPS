import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { parsers } from 'prettier/plugins/babel'
import { ErrorCode, LocalErrorCode } from '../src/error-codes.js'
import { GameError, ensure } from '../src/handlers/common.js'
import { configuration } from '../src/config.js'

test('global codes match every current Lua definition and the resource shortage message table', () => {
    const tables = configuration().tables
    const lua = fs.readFileSync(path.resolve(tables, '../Lua/src/src/proto/ErrCode.lua'), 'utf8')
    const expected = Object.fromEntries(
        [...lua.matchAll(/^\s*(\w+)\s*=\s*(\d+),\s*$/gm)].map(([, name, value]) => [
            name.replace(/^Err[Cc]ode/, ''),
            Number(value),
        ]),
    )
    assert.deepEqual(ErrorCode, expected)
    assert.ok(Object.isFrozen(ErrorCode))
    const messages = JSON.parse(fs.readFileSync(path.join(tables, 'errorCode.json'), 'utf8'))
    assert.equal(messages.find((row) => row.id === ErrorCode.ItemNotEnough).name, '物品不足')
    assert.match(messages.find((row) => row.id === ErrorCode.SoulEssenceBagFull).name, /灵子/)
    assert.match(messages.find((row) => row.id === ErrorCode.OrnamentBagFull).name, /装备/)
    assert.equal(LocalErrorCode.OfflinePaymentCallback, -9999 >>> 0)
    assert.equal(new GameError('invalid').code, ErrorCode.InvalidArgument)
    assert.throws(
        () => ensure(false),
        (error) => error.code === ErrorCode.InvalidArgument,
    )
})

test('runtime error paths use registered names instead of inline numeric codes', () => {
    const root = new URL('../src/', import.meta.url)
    for (const file of fs.readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.js'))) {
        const source = fs.readFileSync(new URL(file.replaceAll('\\', '/'), root), 'utf8')
        assert.doesNotMatch(source, /error:\d+/, `${file}: inline historical error status`)
        const ast = parsers.babel.parse(source)
        const label = (node) => `${file}:${node.loc.start.line}`
        function walk(node, parent) {
            if (!node || typeof node !== 'object') return
            if (node.type === 'MemberExpression' && ['ErrorCode', 'LocalErrorCode'].includes(node.object?.name)) {
                const codes = node.object.name === 'ErrorCode' ? ErrorCode : LocalErrorCode
                assert.ok(Object.hasOwn(codes, node.property.name), `${label(node)} unknown error name`)
            }
            if (node.type === 'CallExpression' && node.callee?.name === 'ensure')
                assert.notEqual(node.arguments[2]?.type, 'NumericLiteral', label(node))
            if (node.type === 'NewExpression' && node.callee?.name === 'GameError')
                assert.notEqual(node.arguments[1]?.type, 'NumericLiteral', label(node))
            if (node.type === 'AssignmentPattern' && node.left?.name === 'code')
                assert.notEqual(node.right.type, 'NumericLiteral', label(node))
            if (node.type === 'BinaryExpression' && ['code', 'error_code'].includes(node.left?.property?.name))
                assert.notEqual(node.right?.type, 'NumericLiteral', label(node))
            if (
                node.type === 'ObjectProperty' &&
                ['errcode', 'ret_code', 'error_code', 'error'].includes(node.key?.name)
            )
                assert.notEqual(node.value?.type, 'NumericLiteral', label(node))
            if (
                node.type === 'ConditionalExpression' &&
                /\.code\b/.test(source.slice(node.test.start, node.test.end))
            ) {
                // HTTP status codes are a different namespace from protocol
                // business errors. Allow only an explicitly named mapping
                // consumed by writeHead, with standard HTTP numeric bounds.
                const httpMapping =
                    parent?.type === 'VariableDeclarator' &&
                    parent.id?.name === 'httpStatus' &&
                    /\.writeHead\(httpStatus\b/.test(source) &&
                    [node.consequent, node.alternate].every(
                        (value) => value.type === 'NumericLiteral' && value.value >= 100 && value.value <= 599,
                    )
                if (!httpMapping) {
                    assert.notEqual(node.consequent.type, 'NumericLiteral', label(node))
                    assert.notEqual(node.alternate.type, 'NumericLiteral', label(node))
                }
            }
            for (const [key, value] of Object.entries(node)) {
                if (key === 'loc') continue
                if (Array.isArray(value)) value.forEach((child) => walk(child, node))
                else if (value && typeof value === 'object') walk(value, node)
            }
        }
        walk(ast)
    }
})
