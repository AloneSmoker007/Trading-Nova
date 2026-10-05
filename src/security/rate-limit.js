export class TokenBucket {
  constructor({capacity=60,refillPerSecond=1,now=()=>Date.now()}={}){this.capacity=capacity;this.tokens=capacity;this.refillPerSecond=refillPerSecond;this.last=now();this.now=now;}
  consume(cost=1){const elapsed=Math.max(0,this.now()-this.last)/1000;this.tokens=Math.min(this.capacity,this.tokens+elapsed*this.refillPerSecond);this.last=this.now();if(cost>this.tokens)return false;this.tokens-=cost;return true;}
}
