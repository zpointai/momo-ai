import { Component,type ReactNode } from 'react';
/** A workspace render failure must leave navigation and other modules usable. */
export class WorkspaceBoundary extends Component<{children:ReactNode;name:string},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return{failed:true};}
 render(){return this.state.failed?<div className="empty-page" role="alert"><h2>{this.props.name} could not be displayed</h2><p>Your saved records are retained. Other workspaces remain available.</p><button className="secondary" onClick={()=>this.setState({failed:false})}>Try this workspace again</button></div>:this.props.children;}
}
