// Bounded syntax reader only. Eligibility and wire-progress shape are separate;
// successfully parsing an unknown expression never makes it supported.
export function parseAchievementExpression(text) {
    if (typeof text !== 'string' || !text.length || text.length > 2048) return null
    let p = 0,
        nodes = 0
    const whitespace = () => {
        while (p < text.length && /\s/.test(text[p])) p++
    }
    const fail = () => {
        throw new SyntaxError('Unsupported achievement expression syntax')
    }
    const node = (value) => {
        if (++nodes > 64) fail()
        return value
    }
    const number = () => {
        whitespace()
        const start = p
        while (p < text.length && /[0-9]/.test(text[p])) p++
        if (start === p) fail()
        const n = Number(text.slice(start, p))
        if (!Number.isSafeInteger(n) || n > 0xffffffff) fail()
        return n
    }
    const primary = (depth) => {
        if (depth > 16) fail()
        whitespace()
        if (text[p] === '(') {
            p++
            const value = or(depth + 1)
            whitespace()
            if (text[p++] !== ')') fail()
            return value
        }
        const tokens = [number()]
        whitespace()
        while (text[p] === '#') {
            if (tokens.length >= 16) fail()
            p++
            tokens.push(number())
            whitespace()
        }
        return node({ type: 'leaf', tokens })
    }
    const and = (depth) => {
        let value = primary(depth)
        whitespace()
        while (text.slice(p, p + 2) === '&&') {
            p += 2
            value = node({ type: 'and', left: value, right: primary(depth) })
            whitespace()
        }
        return value
    }
    const or = (depth) => {
        let value = and(depth)
        whitespace()
        while (text.slice(p, p + 2) === '||') {
            p += 2
            value = node({ type: 'or', left: value, right: and(depth) })
            whitespace()
        }
        return value
    }
    try {
        const value = or(0)
        whitespace()
        return p === text.length ? value : null
    } catch (error) {
        if (error instanceof SyntaxError) return null
        throw error
    }
}
