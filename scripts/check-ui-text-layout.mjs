import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const targetUrl = process.env.UI_LAYOUT_URL || 'https://www.optionsedgeflow.com/app?tab=scan'
const storageStatePath = process.env.UI_LAYOUT_STORAGE_STATE
const outputDir = path.resolve('test-results', 'ui-layout')
fs.mkdirSync(outputDir, { recursive: true })

const launch = async () => {
  try {
    return await chromium.launch({ channel: 'chrome', headless: true })
  } catch {
    return chromium.launch({ headless: true })
  }
}

const browser = await launch()
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'small-desktop', width: 1024, height: 768 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

const failures = []

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport,
      storageState: storageStatePath || undefined,
    })
    const page = await context.newPage()
    await page.goto(targetUrl, { waitUntil: 'networkidle' })

    const auditedGroupCount = await page.locator('[data-layout-audit]').count()
    if (!auditedGroupCount) {
      throw new Error(
        'No layout-audit elements were found. For authenticated pages, set UI_LAYOUT_STORAGE_STATE to a Playwright storage-state file.'
      )
    }

    const issues = await page.locator('[data-layout-audit]').evaluateAll(groups => {
      const found = []
      for (const group of groups) {
        const groupName = group.getAttribute('data-layout-audit') || 'unnamed-group'
        const cells = [...group.querySelectorAll('[data-layout-cell]')]
          .filter(cell => {
            const style = getComputedStyle(cell)
            const rect = cell.getBoundingClientRect()
            return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
          })
          .map(cell => ({
            text: cell.textContent?.trim() || '',
            rect: cell.getBoundingClientRect().toJSON(),
            clipped: cell.scrollWidth > cell.clientWidth + 1,
          }))
          .filter(cell => cell.text)

        for (let index = 0; index < cells.length; index += 1) {
          const cell = cells[index]
          if (cell.clipped) found.push(`${groupName}: "${cell.text}" is horizontally clipped`)
          for (let otherIndex = index + 1; otherIndex < cells.length; otherIndex += 1) {
            const other = cells[otherIndex]
            const overlapX = Math.min(cell.rect.right, other.rect.right) - Math.max(cell.rect.left, other.rect.left)
            const overlapY = Math.min(cell.rect.bottom, other.rect.bottom) - Math.max(cell.rect.top, other.rect.top)
            if (overlapX > 1 && overlapY > 1) {
              found.push(`${groupName}: "${cell.text}" overlaps "${other.text}"`)
            }
          }
        }
      }
      return found
    })

    if (issues.length) {
      const screenshot = path.join(outputDir, `${viewport.name}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      failures.push(...issues.map(issue => `${viewport.name}: ${issue}`), `${viewport.name}: screenshot ${screenshot}`)
    }
    await context.close()
  }
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(`UI layout audit failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}

console.log(`UI layout audit passed for ${viewports.map(viewport => viewport.name).join(', ')}`)
