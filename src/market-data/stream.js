export class MarketStreamSupervisor {
  constructor({connect,now=()=>Date.now(),maxAgeMs=10000,maxRetries=5}={}){if(typeof connect!=="function")throw new Error("stream connect required");this.connect=connect;this.now=now;this.maxAgeMs=maxAgeMs;this.maxRetries=maxRetries;this.state="DISCONNECTED";this.lastEventAt=null;this.sequence=null;this.retries=0;}
  async start(){this.state="CONNECTING";return this.connect({onEvent:e=>this.accept(e),onClose:()=>{this.state="DISCONNECTED";},onError:()=>{this.state="DEGRADED";}}).then(x=>{this.state="CONNECTED";this.retries=0;return x;});}
  accept(event){if(!event?.sequence && event?.sequence!==0)throw new Error("market sequence required");if(this.sequence!==null&&event.sequence!==this.sequence+1){this.state="GAP";return {accepted:false,reason:"SEQUENCE_GAP"};}this.sequence=event.sequence;this.lastEventAt=this.now();this.state="CONNECTED";return {accepted:true};}
  freshness(){return this.lastEventAt!==null&&this.now()-this.lastEventAt<=this.maxAgeMs;}
  canTrade(){return this.state==="CONNECTED"&&this.freshness();}
  backoffMs(){const n=Math.min(this.retries++,this.maxRetries);return Math.min(30000,250*2**n);}
}
