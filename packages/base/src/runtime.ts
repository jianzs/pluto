export enum Type {
  AWS = "AWS",
  K8s = "K8S",
  Azure = "AZURE",
  GCP = "GCP",
  AliCloud = "ALICLOUD",
  Simulator = "SIMULATOR",
  Custom = "CUSTOM",
}

export function isRuntimeType(value: any): value is Type {
  return Object.values(Type).includes(value);
}

export function same(b: string, a: Type): boolean {
  return a == b.toUpperCase();
}
