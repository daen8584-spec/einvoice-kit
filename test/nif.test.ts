import { describe, expect, it } from "vitest";
import { validateTaxId } from "../src/es/nif.js";

describe("Spanish tax IDs", () => {
  it.each([
    ["12345678Z", "DNI"],
    ["00000000T", "DNI"],
    ["89890001K", "DNI"], // AEAT's test NIF from the Verifactu documentation
    ["X1234567L", "NIE"],
    ["A28015865", "ENTITY"], // a real company NIF
    ["A46103834", "ENTITY"], // another real company NIF
    ["B12345674", "ENTITY"],
  ])("accepts %s", (id, kind) => {
    expect(validateTaxId(id)).toEqual({ valid: true, kind, normalized: id });
  });

  it("cleans up spacing, dots and an ES prefix", () => {
    expect(validateTaxId(" es-a28.015.865 ")).toMatchObject({ valid: true, normalized: "A28015865" });
  });

  it("catches a single wrong character", () => {
    expect(validateTaxId("12345678A")).toEqual({ valid: false, reason: "check" });
    expect(validateTaxId("A28015866")).toEqual({ valid: false, reason: "check" });
    expect(validateTaxId("X1234567T")).toEqual({ valid: false, reason: "check" });
  });

  it("rejects things that aren't tax IDs", () => {
    expect(validateTaxId("hello")).toEqual({ valid: false, reason: "format" });
    expect(validateTaxId("1234567Z")).toEqual({ valid: false, reason: "format" });
  });
});
