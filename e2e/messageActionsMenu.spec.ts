import { expect, test } from "@playwright/test";

// The expanded message actions sit directly left of the ⋯ trigger, bottom-aligned,
// at every interface scale (root CSS zoom), and the trigger opens them on every click.
for (const scale of [1, 1.25, 1.5, 0.8]) {
  test(`message actions open beside the trigger at scale ${String(scale)}`, async ({ page }) => {
    const url = process.env["PI_WEB_E2E_CHAT_URL"];
    if (url === undefined) throw new Error("Isolated PI WEB was not started");
    await page.addInitScript((value) => { localStorage.setItem("pi-web-app-scale", value); }, String(scale));
    await page.goto(url);
    const message = page.locator('chat-view article[data-entry-id="e2e00002"]');
    const trigger = message.getByRole("button", { name: "Message actions" });
    const strip = message.locator(".msg-actions-strip");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await message.hover();
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
      await expect(strip).toBeVisible();
      await page.waitForTimeout(250); // let the slide-in transition finish
      const [t, s] = await Promise.all([trigger.boundingBox(), strip.boundingBox()]);
      if (t === null || s === null) throw new Error("no boxes");
      expect(Math.abs(s.x + s.width - t.x), `right edge vs trigger left (${JSON.stringify({ t, s })})`).toBeLessThan(2);
      expect(Math.abs(s.y + s.height - (t.y + t.height)), `bottom vs trigger bottom (${JSON.stringify({ t, s })})`).toBeLessThan(2);
      await trigger.click();
      await expect(trigger).toHaveAttribute("aria-expanded", "false");
      await expect(strip).toBeHidden();
    }
  });
}
