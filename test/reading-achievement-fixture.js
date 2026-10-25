import { achievementFixture } from './achievement-fixture.js'
export function readingAchievementFixture(name, file = ':memory:') {
    const f = achievementFixture(name, file)
    const edit = (fn) => f.store.transact(f.session.id, 0, fn)
    edit((s) => {
        s.tasks = []
    })
    const acquire = (id) => f.call('ReadHandbookGet', { book_id: id, get_type: 1 })
    const wire = (packets, id) =>
        packets
            .filter((p) => p.id === 9900)
            .flatMap((p) => f.protocol.decode('SCAchievementSync', p.payload).achievements)
            .find((r) => r.achievement_id === id)
    return { ...f, edit, acquire, wire }
}
