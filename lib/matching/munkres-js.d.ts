declare module "munkres-js" {
  function computeMunkres(costMatrix: number[][], options?: { padValue?: number }): Array<[number, number]>;
  export = computeMunkres;
}
