import React from 'react';
import { NerdletStateContext, PlatformStateContext } from 'nr1';
import Main from './main.js'

// https://docs.newrelic.com/docs/new-relic-programmable-platform-introduction

export default class TBAIndex extends React.Component {
    
    render() {
        return (
            <PlatformStateContext.Consumer>
            {(platformState) => <NerdletStateContext.Consumer>
                {    
                (nerdletState) => <Main nerdletState={nerdletState} platformState={platformState}/>
                }
            </NerdletStateContext.Consumer>}

            </PlatformStateContext.Consumer>
        )
    }
}