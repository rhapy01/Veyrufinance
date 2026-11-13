export function areAddressesEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}
