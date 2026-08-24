import { afterEach, describe, expect, it } from "vitest";
import {
  canOpenSettings,
  openSettingsSection,
  registerSettingsOpener,
} from "./settingsNavigation";

afterEach(() => registerSettingsOpener(null));

describe("settings navigation seam", () => {
  it("reports nothing listening before App registers", () => {
    expect(canOpenSettings()).toBe(false);
    expect(openSettingsSection("storage")).toBe(false);
  });

  it("hands the section to the registered opener", () => {
    const seen: string[] = [];
    registerSettingsOpener((section) => seen.push(section));
    expect(canOpenSettings()).toBe(true);
    expect(openSettingsSection("storage")).toBe(true);
    expect(seen).toEqual(["storage"]);
  });

  it("stops routing once App unmounts", () => {
    registerSettingsOpener(() => {
      throw new Error("must not be called after unregister");
    });
    registerSettingsOpener(null);
    expect(openSettingsSection("storage")).toBe(false);
  });
});
