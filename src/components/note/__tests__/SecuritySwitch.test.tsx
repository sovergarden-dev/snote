import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SecuritySwitch } from "../SecuritySwitch";

describe("SecuritySwitch LTR geometry", () => {
  it("places the thumb on the left for OFF and the right for ON", () => {
    const { rerender, getByRole, getByTestId } = render(
      <p id="switch-label">Encrypt</p>,
    );
    const view = (checked: boolean) => (
      <SecuritySwitch
        checked={checked}
        labelledBy="switch-label"
        onCheckedChange={vi.fn()}
      />
    );
    rerender(
      <>
        <p id="switch-label">Encrypt</p>
        {view(false)}
      </>,
    );
    const off = getByRole("switch", { name: "Encrypt" });
    expect(off).toHaveAttribute("aria-checked", "false");
    expect(off.querySelector("[data-state]") ).toHaveAttribute("data-state", "unchecked");
    expect(off.querySelector("[data-state]")?.className).toMatch(/bg-muted/);
    expect(off.querySelector("[data-state]")?.className).not.toMatch(/bg-primary(?:\s|$)/);
    expect(getByTestId("security-switch-thumb").className).toMatch(/translate-x-0/);
    expect(getByTestId("security-switch-thumb").className).not.toMatch(/translate-x-4/);
    expect(getByTestId("security-switch-thumb").className).toMatch(/bg-foreground/);

    rerender(
      <>
        <p id="switch-label">Encrypt</p>
        {view(true)}
      </>,
    );
    const on = getByRole("switch", { name: "Encrypt" });
    expect(on).toHaveAttribute("aria-checked", "true");
    expect(on.querySelector("[data-state]")).toHaveAttribute("data-state", "checked");
    expect(on.querySelector("[data-state]")?.className).toMatch(/bg-primary/);
    expect(on.querySelector("[data-state]")?.className).not.toMatch(/bg-foreground/);
    expect(getByTestId("security-switch-thumb").className).toMatch(/translate-x-4/);
    expect(getByTestId("security-switch-thumb").className).toMatch(/bg-primary-foreground/);
  });

  it("keeps the thumb side when disabled and exposes describedby", () => {
    const { getByRole, getByTestId } = render(
      <>
        <p id="switch-label">Legacy</p>
        <p id="switch-help">Turn encryption off first.</p>
        <SecuritySwitch
          checked={false}
          disabled
          labelledBy="switch-label"
          describedBy="switch-help"
          onCheckedChange={vi.fn()}
        />
      </>,
    );
    const sw = getByRole("switch", { name: "Legacy" });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAttribute("aria-disabled", "true");
    expect(sw).toHaveAttribute("aria-describedby", "switch-help");
    expect(getByTestId("security-switch-thumb").className).toMatch(/translate-x-0/);
    expect(getByTestId("security-switch-thumb").className).not.toMatch(/translate-x-4/);
  });
});
