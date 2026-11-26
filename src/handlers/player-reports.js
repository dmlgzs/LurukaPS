import { submitPlayerReport } from '../player-reports.js'
export function registerPlayerReports(on, store) {
    on('ReportOnPlayer', (c, request) => {
        submitPlayerReport(c, request, store)
        return {}
    })
}
