import React from 'react';
import { HeadingText, NerdGraphQuery, Tooltip,AutoSizer,EntityByGuidQuery, TableChart, Icon, AccountPicker, Spinner,  Grid, GridItem, Table,TableHeader,TableHeaderCell,TableRow,SparklineTableRowCell,TableRowCell } from 'nr1';
import moment from 'moment';

const MAX_DAYS_TO_DISPLAY=31*12; //limit the number of days to display 

const STATES = {
    SUCCESS_NOTMUTED: 'SUCCESS_NOTMUTED',
    FAILED_NOTMUTED: 'FAILED_NOTMUTED',
    SUCCESS_MUTED: 'SUCCESS_MUTED',
    FAILED_MUTED: 'FAILED_MUTED',
    SUCCESS_UNKNOWN: 'SUCCESS_UNKNOWN',
    FAILED_UNKNOWN: 'FAILED_UNKNOWN',
  };
  const STATE_COLOURS = {
    SUCCESS_NOTMUTED: 'lightgreen',
    FAILED_NOTMUTED: '#f24c4c',
    SUCCESS_MUTED: '#add9c0',
    FAILED_MUTED: '#ddaeae',
    SUCCESS_UNKNOWN: '#9cb3e9',
    FAILED_UNKNOWN: '#eca262',
  };


export default class TimeBasedAvailabilityNerdletNerdlet extends React.Component {

    constructor(props) {
        super(props)
        this.state = {  entityData: null, monitorData: null, accountId: null, showAccountPicker:false, loading: {toLoad: 0, loaded: 0}, sort: {} }
        for(let i=0; i < 9; i++){
            this.state.sort['column_'+i]=TableHeaderCell.SORTING_TYPE.NONE
        }
        this.onChangeAccount = this.onChangeAccount.bind(this);
    }


    onChangeAccount(_,value) {
        this.setState({ monitorData:null, accountId: value });   
    }

    /*
    * asyncForEach()
    *
    * A handy version of forEach that supports await.
    * @param {Object[]} array     - An array of things to iterate over
    * @param {function} callback  - The callback for each item
    */
    async asyncForEach(array, callback) {
        for (let index = 0; index < array.length; index++) {
        await callback(array[index], index, array);
        }
    }


    async componentDidMount() {
        const {nerdletState,platformState} = this.props
        if(nerdletState.entityGuid) {
            EntityByGuidQuery.query({
                entityGuid: nerdletState.entityGuid,
            }).then(({ data }) => {
                if(data.entities[0].domain=='SYNTH' && data.entities[0].type=='MONITOR' ) {
                    this.setState({entityData:data.entities[0]})
                    this.processData(data.entities[0])     
                }
            })
        } else {
            this.setState({showAccountPicker: true}); // We only show account picker if not viewing app on a specific entity
        }
        this.setDatesFromTimeRange(platformState?.timeRange.begin_time, platformState?.timeRange.end_time, ()=>{})
    }

    async componentDidUpdate(prevProps) {
        const {platformState} = this.props
        const {entityData} = this.state;
        if(prevProps?.platformState?.timeRange?.begin_time != platformState?.timeRange.begin_time ||
            prevProps?.platformState?.timeRange?.end_time != platformState?.timeRange.end_time
            ) {
            // reload data if new time window selected
            this.setDatesFromTimeRange(platformState?.timeRange.begin_time,platformState?.timeRange.end_time, ()=>{this.processData(entityData);})
        }
    }

    //Configures the time range for data selection based on chosend time window.
    setDatesFromTimeRange(begin, end, callback) {
        let beginTime = begin==null ? moment().valueOf() : begin;
        let endTime = begin==null ? moment().valueOf() : end;
        console.log("setting time",beginTime,endTime);
        console.log(`From ${moment(beginTime).utc().startOf('day').format()} to but not including ${moment(endTime).add(1,'day').utc().startOf('day').format()}`); 
        let dayBegin = moment(beginTime).utc().startOf('day').valueOf();
        let dayEnd = moment(endTime).add(1,'day').utc().startOf('day').valueOf();
        let periodDays= (dayEnd-dayBegin) / (60*60*24*1000)
        this.setState({beginTime:dayBegin, endTime:dayEnd, periodDays:periodDays, monitorData:null },()=>{callback();})
    }


    //Main data processor. Gathers data and generates output
    async processData(entityData) {

        console.log("PROCESS DATA CALLED");
        const {accountId, beginTime, endTime, showAccountPicker } = this.state;
        if(showAccountPicker) {
            return null; // global mode dont load data for monitors in this mode. Exit.
        }

        let chosenAccount=accountId;
        let restrictedMonitorClause="";
        if(entityData) {
            restrictedMonitorClause=`where entityGuid='${entityData.guid}'`;
            chosenAccount=entityData.accountId;
        } 
        
        //Load monitor  data to determine what is in scope  (this now only loads the monitor for tone entity)
        let candidateMonitors=await this.loadData(chosenAccount,`FROM SyntheticCheck select count(*) as 'checks', latest(monitorName) as 'monitorName', uniqueCount(location) as locations facet monitorId since ${beginTime} until ${endTime} ${restrictedMonitorClause} limit max` ) ;
        let monitorData=[];
        this.setState({loading: { toLoad: candidateMonitors.length, loaded: 0}});

        //Load data for this monitor (this used to load multiple monitors)
        await this.asyncForEach(candidateMonitors,async (monitor)=>{

            //Determine the locations this monitor has been running in
            const locations= await this.loadData(chosenAccount,`FROM SyntheticCheck select uniques(location) as location since ${beginTime} until ${endTime} where monitorId='${monitor.monitorId}'` )   ;
            const locationsArray=locations[0] && locations[0].location ? locations[0].location : [];

            let thisMonitorData={ name: monitor.monitorName, id: monitor.monitorId, locations:{ }};
            console.log(`Loading monitor data for ${monitor.monitorName}`);

            //Load synhtetic check information
            let checks= await this.loadData(chosenAccount,`FROM SyntheticCheck select location, result, custom.muteStatus  as muteStatus where monitorId='${monitor.monitorId}' limit max`,beginTime,endTime,locationsArray);

            //Compose the object of checks by location
            checks.forEach((check)=>{
                if(!thisMonitorData.locations[check.location]) {
                    thisMonitorData.locations[check.location]={rawResults: []};
                }
                thisMonitorData.locations[check.location].rawResults.push({result: check.result, timestamp:check.timestamp, muteStatus: check.muteStatus});
            })
            
            //sort the records so that the oldest come first
            Object.keys(thisMonitorData.locations).forEach((location)=>{
                thisMonitorData.locations[location].rawResults.sort((a,b)=>{ return a.timestamp > b.timestamp ? 1 : -1})
            })
            monitorData.push(thisMonitorData)
            this.setState({loading: { toLoad: candidateMonitors.length, loaded: monitorData.length}})
        })


        //search for all overlapping outtage windows (by location)
        monitorData.forEach(monitor=>{
            for(const loc in monitor.locations) {
                monitor.locations[loc].downPeriods=[];
                monitor.locations[loc].statePeriods=[];

                let currentState=STATES.SUCCESS_NOTMUTED; //we start from an assumed good state.
                let lastStateStart=null;


                monitor.locations[loc].rawResults.forEach((check,idx)=>{

                    if(lastStateStart === null) { 
                        lastStateStart=moment(check.timestamp).startOf('day').utc().valueOf(); //first result might come in sometime after 00:00 so should be padded out back to start of day
                    } 

                    //set the monitors first and last timestamps
                    if(check.timestamp < monitor.firstEntry || monitor.firstEntry === undefined ) {
                        monitor.firstEntry = check.timestamp
                    }
                    if(check.timestamp > monitor.lastEntry || monitor.lastEntry === undefined ) {
                        monitor.lastEntry = check.timestamp
                    }
         
                    // look for muted state
                    let checkState=check.result;
                    if(check.muteStatus===null ) {
                        checkState+="_NOTMUTED";
                    } else {
                        checkState+="_"+check.muteStatus;
                    }

                    if(checkState!==currentState || idx == (monitor.locations[loc].rawResults.length-1)) { //ensure the last entry triggers a closure too regarldess of its result
                        let endTimestamp=check.timestamp;
                        if(idx == (monitor.locations[loc].rawResults.length-1)) {
                            endTimestamp=moment(check.timestamp).endOf('day').utc().valueOf() + 1; //last check of the day? then pad out to end of day.
                            check.timestamp=endTimestamp;
                        }
                        const duration=endTimestamp-lastStateStart;
                        monitor.locations[loc].statePeriods.push({start: lastStateStart, end: check.timestamp, duration: duration, state: currentState}); //record the previous state data
            
                        //reset pointers for next loop
                        lastStateStart=check.timestamp;
                        currentState=checkState;
                    }

                })
            }
        })

        //find complete outage periods, this is where the check fails across all locations at same time
        monitorData.forEach(monitor=>{
            monitor.overlapPeriods=[];
            let locations = Object.keys(monitor.locations);
            for (const location of locations) {
                let otherLocations=locations.filter(loc=>{return loc!=location}) ;// remove the current location from list of others
    
                monitor.locations[location].statePeriods.forEach((period)=>{ //iterate over this locations outages and search for overlaps in others
                    if([STATES.FAILED_MUTED,STATES.FAILED_NOTMUTED,STATES.FAILED_UNKNOWN].includes(period.state)) {
                        let latestStart=period.start;
                        let earliestEnd=period.end;
                        let locationsWithOverlap=1;
                        for(const loc of otherLocations) {
                            let overlapPresent=false; //there might be more than one overlap
                            for(const comparePeriod of monitor.locations[loc].statePeriods){
                                if([STATES.FAILED_MUTED,STATES.FAILED_NOTMUTED,STATES.FAILED_UNKNOWN].includes(comparePeriod.state)) {
                                    if(comparePeriod.start <= earliestEnd &&  comparePeriod.end >= latestStart) {
                                            latestStart = (comparePeriod.start > latestStart && comparePeriod.start <= earliestEnd) ? comparePeriod.start : latestStart;
                                            earliestEnd = (comparePeriod.end < earliestEnd &&  comparePeriod.end >= latestStart)? comparePeriod.end : earliestEnd;
                                            overlapPresent=true;
                                    }
                                }
                            }
                            if(overlapPresent) {locationsWithOverlap++;}
                        }

                        if(locationsWithOverlap >= locations.length) { //we only consider it an outtge if ALL locations are failing
                            monitor.overlapPeriods.push({start:latestStart, end:earliestEnd, duration: earliestEnd-latestStart});
                        }
                    }
                })
            }
        })
        this.setState({monitorData:monitorData});

    }
  
    //load multiple nrql queries at once and return composed object with all results via promise
    async loadMultiData(accountId,nrql){
        let innerQuery=nrql.map((q,idx)=>{
            return `
            queryData_${idx}: nrql(query: "${q}") {results}`
        });

        let promise = new Promise(function(resolve,reject){
            let query = `
            query($accountId: Int!) {
                actor {
                    account(id: $accountId) {
                        ${innerQuery}
                    }
                }
            }`;
            console.log("Multi query",query);
            //console.log({ query: query, variables: { accountId: accountId}, fetchPolicyType: NerdGraphQuery.FETCH_POLICY_TYPE.NO_CACHE });
            const gql = NerdGraphQuery.query({ query: query, variables: { accountId: accountId}, fetchPolicyType: NerdGraphQuery.FETCH_POLICY_TYPE.NO_CACHE });
            gql.then(results => {
                console.log(`Results for GQL Query received `,results);
                let combinedData=[]
                for(let idx=0; idx < nrql.length; idx++) {
                    combinedData=[...combinedData, ...results.data.actor.account[`queryData_${idx}`].results ];
                }
                resolve(combinedData);
    
            }).catch((error) => { console.log(`Problem with query`); console.log(error); reject() })
        })
        return promise; 
    }

    //loads the data for given time period
    loadData(accountId,nrql,beginTime, endTime,locationOptions) {

        let queryPromises=[]
        let numberPromises=1;
        let days=null;

        //determine how many days this data covers
        if(endTime!=undefined && beginTime!=undefined) {
            days = (endTime-beginTime) / (60*60*24*1000);
        if(days > MAX_DAYS_TO_DISPLAY) { days=MAX_DAYS_TO_DISPLAY; console.error(`Days window limited to ${MAX_DAYS_TO_DISPLAY}`);}
            numberPromises=days;
            console.log("Days",days)
        }

        //generate query for each day
        for (let dayIndex=0; dayIndex < numberPromises; dayIndex++) {
            queryPromises.push(
                new Promise(function(resolve,reject){
                    let innerQuery=`queryData: nrql(query: "${nrql}") {results}` //if no days set
                    if(days) {  
                        let startDate=moment(beginTime).add(dayIndex,'day').utc().format('YYYY-MM-DD')
                        let endDate=moment(beginTime).add(dayIndex+1,'day').utc().format('YYYY-MM-DD')
                        innerQuery=''
                        //we generate an nrql query for each location
                        for (let loc of locationOptions) {
                            innerQuery+=`queryData_${dayIndex}_${loc}: nrql(query: "${nrql} where location='${loc}' since '${startDate}' until '${endDate}' with timezone 'UTC'") {results}`;
                        }  
                    } 

                    let query = `
                        query($accountId: Int!) {
                        actor {
                            account(id: $accountId) {
                                ${innerQuery}
                            }
                        }
                    }`;
                    console.log(`Dispatching GQL Query ${dayIndex} `);

                    const gql = NerdGraphQuery.query({ query: query, variables: { accountId: accountId}, fetchPolicyType: NerdGraphQuery.FETCH_POLICY_TYPE.NO_CACHE });
                    gql.then(results => {
                        console.log(`Results for GQL Query received ${dayIndex}`)
                        if(days) {
                            let combinedData=[]
                                for (let loc of locationOptions) {
                                combinedData=[...combinedData, ...results.data.actor.account[`queryData_${dayIndex}_${loc}`].results ];
                            }
                            resolve(combinedData);
                        } else {
                            resolve(results.data.actor.account.queryData.results);
                        }
                    }).catch((error) => { console.log(`Problem with query ${dayIndex}`); console.error(error); reject(error) })
                })
            )
        }
        
        //dispatch all the queries
        return Promise.all(queryPromises).then((gqlResults)=>{
            if(days) {
                let allDays=[];
                for(let d=0; d < gqlResults.length; d++) {
                    allDays=[...allDays, ...gqlResults[d]];
                }
                return allDays; 
            } else {
                return gqlResults[0];
            }
        })
    
    }


    // _onClickTableHeaderCell(key, event, sortingData) {
    //     const {sort} = this.state
    //     sort[key]=sortingData.nextSortingType 
    //     this.setState({ sort: sort });
    // }

    //Render method  
    render() {
        const {monitorData, showAccountPicker, accountId, loading, periodDays, beginTime, endTime} = this.state
        let accountSelector = !showAccountPicker 
                                ? null 
                                : <GridItem columnSpan={2}>
                                    <AccountPicker
                                        value={this.state.accountId}
                                        onChange={this.onChangeAccount}
                                    />
                                </GridItem>;
        
        let humanBegin=moment(beginTime).utc().format("dddd, MMMM Do YYYY");
        let humanEnd=moment(endTime).utc().format("dddd, MMMM Do YYYY");
        let timeString=<span>From <strong>{humanBegin}</strong> up to and including <strong>{humanEnd}</strong> ({periodDays} days)</span>;
        if(periodDays==1) {
            timeString=<span>For the day <strong>{humanBegin}</strong> ({periodDays} day)</span>;
        }

        //Show the selected time range (unless we're in global mode)
        let timeRangeDisplay= showAccountPicker 
                            ? null 
                            : <GridItem columnSpan={10}>
                                {timeString}
                            </GridItem>;

        //renders a monitor graphically in a horizontal chart view
        const renderMonitor = (theMonitorData,width) => {                                   
            let monitorRender=[];
            theMonitorData.forEach((monitor)=>{
                let chartWidthPx=width;
                let leftOffset=200;
                let timeSpan=monitor.lastEntry-monitor.firstEntry;
                let pixelRatio=(chartWidthPx-leftOffset)/timeSpan;
                let locationStrips=[];
                let locationSummary=[];

                //for overall overlap monitor outages
                let outages=[];
                let lines=[];
                let unavailable=[];
                let totalOverlapOutageDuration=0;

                //remove duplicate overlapping periods (as each location records its own)
                const dedupeOverlapPeriods = monitor.overlapPeriods.filter((v,i,a)=>a.findIndex(t=>(t.start === v.start && t.end===v.end))===i);
                //sort periods from early to late
                const dedupeOverlapPeriodsSorted=dedupeOverlapPeriods.sort((a,b)=>{ return a.end > b.end ? -1 : 1});

                if(dedupeOverlapPeriodsSorted.length==0) {
                    outages.push(<Tooltip text={"None"}><div style={{left: `${leftOffset + 30}px`, width: '100%'}}  className="outage noOverlap" >No overlapping outages</div></Tooltip>)
                } else {
                    //draw periods
                    dedupeOverlapPeriodsSorted.forEach((outage)=>{

                        let left=leftOffset+ ((outage.start-monitor.firstEntry) * pixelRatio);
                        let width=outage.duration * pixelRatio;

                        totalOverlapOutageDuration+=outage.duration;

                        let durationHuman=moment.duration(outage.duration).humanize();
                        let durationHHMMSS=moment.unix(outage.duration/1000).utc().format("HH:mm:ss"); //TODO fix this to use duration? only a problem if more than 1 day?
                        
                        let toolTipMessage = `${moment.unix(outage.start/1000).format("YYYY-MM-DD HH:mm")} to ${moment.unix(outage.end/1000).format("YYYY-MM-DD HH:mm")} \n Duration: ${durationHuman} (${durationHHMMSS})`;
                        outages.push(<Tooltip text={toolTipMessage}><div style={{left: `${left}px`, width:`${width}px`}} className="outage overlap"></div></Tooltip>);
                        lines.push(<div style={{left: `${left}px`, width:`${width}px`}} className="overlapBox">&nbsp;</div>);

                        unavailable.push({ start: moment.unix(outage.start/1000).format("YYYY-MM-DD HH:mm"), end: moment.unix(outage.end/1000).format("YYYY-MM-DD HH:mm"), duration: Math.floor(moment.duration(outage.duration).asHours()) +  'h '+moment.duration(outage.duration).minutes() + 'm ' + moment.duration(outage.duration).seconds() + 's' });
                    });
                }

                //row container
                let chart=<div className="monitorStrip" style={{width:`${chartWidthPx}px`}}>
                        <span className="monitorLocationLabel" style={{width:`${leftOffset-20}px`}}>100% Unavailable</span>
                        {outages}
                    </div>;
                //add row to overall chart
                locationStrips.push(<div className="monitorStripContainer">
                    {chart}
                </div>);

       
                // Process location summary infomration
                for (const loc in monitor.locations) {

                    let location = loc;
                    let statePeriods=monitor.locations[location].statePeriods;

                    // we need to record the cumulative count and the cumulative duration of each period state
                    const STATE_DURATIONS = {
                        SUCCESS_NOTMUTED:0,
                        FAILED_NOTMUTED: 0,
                        SUCCESS_MUTED: 0,
                        FAILED_MUTED: 0,
                        SUCCESS_UNKNOWN: 0,
                        FAILED_UNKNOWN: 0,
                    };

                    const STATE_COUNTS = {
                        SUCCESS_NOTMUTED:0,
                        FAILED_NOTMUTED: 0,
                        SUCCESS_MUTED: 0,
                        FAILED_MUTED: 0,
                        SUCCESS_UNKNOWN: 0,
                        FAILED_UNKNOWN: 0,
                    };
                    
                    statePeriods.forEach((period)=>{
                        STATE_DURATIONS[period.state]=STATE_DURATIONS[period.state] + period.duration;
                        STATE_COUNTS[period.state]=STATE_COUNTS[period.state]+1;
                    });

                    //Derive summarised data
                    let successDuration=STATE_DURATIONS.SUCCESS_NOTMUTED + STATE_DURATIONS.SUCCESS_MUTED + STATE_DURATIONS.SUCCESS_UNKNOWN;
                    let failedDuration=STATE_DURATIONS.FAILED_NOTMUTED + STATE_DURATIONS.FAILED_MUTED + STATE_DURATIONS.FAILED_UNKNOWN;
                    let totalDurations=STATE_DURATIONS.SUCCESS_NOTMUTED + STATE_DURATIONS.SUCCESS_MUTED + STATE_DURATIONS.SUCCESS_UNKNOWN + STATE_DURATIONS.FAILED_NOTMUTED + STATE_DURATIONS.FAILED_MUTED + STATE_DURATIONS.FAILED_UNKNOWN;
                    let percentAvailable= 100 - ((  failedDuration / totalDurations ) * 100);
                    locationSummary.push({
                        location: location, 
                        successDuration: successDuration,
                        failedDuration: failedDuration,
                        totalDurations: totalDurations,
                        percentAvailable: percentAvailable.toFixed(2)+"%",
                        failedCount: STATE_COUNTS.FAILED_NOTMUTED + STATE_COUNTS.FAILED_MUTED + STATE_COUNTS.FAILED_UNKNOWN,
                        successCount: STATE_COUNTS.SUCCESS_NOTMUTED + STATE_COUNTS.SUCCESS_MUTED + STATE_COUNTS.SUCCESS_UNKNOWN,
                        states: STATE_DURATIONS,
                        counts: STATE_COUNTS
                    });
        
                    //determine individual location summaries
                    let outages=[]
                    monitor.locations[loc].statePeriods=monitor.locations[loc].statePeriods.sort((a,b)=>{return a.start > b.start})
                    monitor.locations[loc].statePeriods.forEach((outage,idx)=>{
                        let left=leftOffset + ((outage.start-monitor.firstEntry) * pixelRatio);
                        left = left < leftOffset ? leftOffset: left; //can be negative if its first entry of the day
                        console.log("Last one?",monitor.lastEntry,monitor.locations[loc].statePeriods.length==idx+1 );

                        let width=outage.duration * pixelRatio
                        let durationHuman=moment.duration(outage.duration).humanize()
                        let durationHHMMSS=moment.unix(outage.duration/1000).utc().format("HH:mm:ss") //TODO fix this to use duration
                        let toolTipMessage = `${outage.state}\n${moment.unix(outage.start/1000).format("YYYY-MM-DD HH:mm")} to ${moment.unix(outage.end/1000).format("YYYY-MM-DD HH:mm")} \n Duration: ${durationHuman} (${durationHHMMSS})`;
                        outages.push(<Tooltip text={toolTipMessage}><div style={{backgroundColor:STATE_COLOURS[outage.state], left: `${left}px`, width:`${width}px`}} className="outage"></div></Tooltip>)
                    });


                    //add location row to chart
                    let chart=<div className="monitorStrip" style={{width:`${chartWidthPx}px`}}>
                        <span className="monitorLocationLabel" style={{width:`${leftOffset-20}px`}}>{loc}</span>
                        {outages}
                    </div>;

                    locationStrips.push(<div className="monitorStripContainer">
                        {chart}
                    </div> );

                }

                // Construct render for the individual location summaries
                let locationSummaryBlocks=[];
                locationSummary.forEach(location => {

                    let statesSummaries=[];
                    Object.keys(location.states).forEach(state => {
                        let stateDuration=location.states[state];
                        let stateCount=location.counts[state];
                        let percenDuration=(stateDuration / location.totalDurations) * 100;
                        statesSummaries.push({
                            state: state,
                            duration: `${Math.floor(moment.duration(stateDuration).asHours())}h ${moment.duration(stateDuration).minutes()}m ${moment.duration(stateDuration).seconds()}s `,
                            count: stateCount,
                            percentOfTotal:  percenDuration.toFixed(2)+'%'
                        });

                    });

                    const locationSummaryTableData=  [
                    {
                        metadata: {
                            id: 'series-1',
                            name: 'Series 1',
                            color: '#008c99',
                            viz: 'main',
                            columns: ['state', 'duration', 'count','percentOfTotal']
                        },
                        data: statesSummaries
                    }];

                    let totalDurations=`${Math.floor(moment.duration(location.totalDurations).asHours())}h ${moment.duration(location.totalDurations).minutes()}m ${moment.duration(location.totalDurations).seconds()}s `;
                    let totalFailedDuration=`${Math.floor(moment.duration(location.failedDuration).asHours())}h ${moment.duration(location.failedDuration).minutes()}m ${moment.duration(location.failedDuration).seconds()}s `;
                    let percentAvailable=location.percentAvailable;

                    locationSummaryBlocks.push(
                        <div className="summaryTable">
                            <HeadingText type={HeadingText.TYPE.HEADING_3}><Icon type={Icon.TYPE.LOCATION__LOCATION__PIN} /> {location.location} Location</HeadingText><br />
                            <div>Availability: {percentAvailable}</div>
                            <div>Run time: {totalDurations}</div>
                            <div>Failed: {totalFailedDuration} ({location.failedCount} occurences)</div><br />
                            <TableChart data={locationSummaryTableData} style={{height: "20em",width:"100%",minWidth:"30em", maxWidth:"80em"}}  />
                        </div>
                    );
                }
                );



                let durationHuman=moment.duration(totalOverlapOutageDuration).humanize()
                let durationSeconds=Math.round(moment.duration(totalOverlapOutageDuration).asSeconds())
                let durationHHMMSS=`${Math.floor(moment.duration(totalOverlapOutageDuration).asHours())}h ${moment.duration(totalOverlapOutageDuration).minutes()}m ${moment.duration(totalOverlapOutageDuration).seconds()}s `
                let percentAvailable=100-((durationSeconds/(periodDays*24*60*60))*100)

                const tableData=  [
                    {
                        metadata: {
                            id: 'series-1',
                            name: 'Series 1',
                            color: '#008c99',
                            viz: 'main',
                            columns: ['start', 'end', 'duration'],
                        },
                        data: unavailable
                    }];
                            
                monitorRender.push(<div className="monitorRow" >
                    <HeadingText type={HeadingText.TYPE.HEADING_3}><Icon type={Icon.TYPE.HARDWARE_AND_SOFTWARE__SOFTWARE__MONITORING}  /> Historical success/failure timeline</HeadingText>
                    <div className="monitorChart">
                        {lines}
                        {locationStrips}
                    </div>
                    <div>
                        <span style={{marginLeft: "2em",  backgroundColor: STATE_COLOURS.SUCCESS_NOTMUTED}}>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Success
                        <span style={{marginLeft: "2em",  backgroundColor: STATE_COLOURS.FAILED_NOTMUTED}} >&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Failed
                        <span style={{marginLeft: "2em",  backgroundColor: STATE_COLOURS.SUCCESS_MUTED}}>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Success (muted)
                        <span style={{marginLeft: "2em",  backgroundColor: STATE_COLOURS.FAILED_MUTED}}>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Failed (muted)
                        <span style={{marginLeft: "2em",  backgroundColor: STATE_COLOURS.SUCCESS_UNKNOWN}}>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Success (unkown)
                        <span style={{marginLeft: "2em",  backgroundColor: STATE_COLOURS.FAILED_UNKNOWN}}>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> Failed (unkown)
             
                    </div>
                    <div className="summaryTable">
                    <HeadingText type={HeadingText.TYPE.HEADING_3}><Icon type={Icon.TYPE.INTERFACE__STATE__PUBLIC} /> Multi Location Overlap</HeadingText><br />
                        <div>{`Availability: ${percentAvailable.toFixed(2)}%`}</div>
                        <div>{`Unavailable for ${durationHuman} (${durationHHMMSS} or ${durationSeconds} seconds)`}</div>
                        <TableChart data={tableData} style={{width:"100%",minWidth:"30em", maxWidth:"80em"}}  />
                    
                    </div>
                    {locationSummaryBlocks}
                    
                </div>)

            });

            return monitorRender;
        }
        

        let dataRender="";
        if (accountId) {
            let loadingProgress= (loading.toLoad>0) ?  `${loading.loaded+1}/${loading.toLoad} (${Math.round(((loading.loaded+1)/loading.toLoad)*100)}%)` : '';
            dataRender=<Grid><GridItem columnSpan={12} >Loading historical data for monitors... {loadingProgress} <Spinner inline /></GridItem></Grid>;
        } else if(!showAccountPicker ){
            dataRender=<>
             <Grid ><GridItem style={{paddingBottom: "2em"}} columnSpan={12} >Loading historical monitor data... <Spinner inline /></GridItem></Grid>
            </>;
        }

        if(monitorData) {
            //entity mode
            dataRender=<div style={{width:"100%"}} className="nerdletContainer">
                        <Grid>
                            <GridItem columnSpan={12}>&nbsp;
                                <AutoSizer>
                                    {({ width }) => {
                                        return renderMonitor(monitorData,width)
                                    }}
                                </AutoSizer>
                            </GridItem>
                        </Grid>
                </div>;
        } else if(accountId) {
            //Global mode, show results from generated summary table (if available) - see generator script
            dataRender=<div style={{width:"100%"}} className="nerdletContainer">
                <Grid>
                    <GridItem columnSpan={12}>&nbsp;
                    <TableChart style={{width:"100%", height:"40em", minWidth:"30em", maxWidth:"80em"}}
                        accountIds={[accountId]}
                        query="FROM syntheticTBABotSummary select latest(durationBreakdown) as 'Total Down Time', latest(percent) where state='SUMMARY'  facet monitorName, location, period, periodEnd limit max since 4 week ago"
                        
                    />
                    </GridItem>
                </Grid>
             </div>;
        }

        return <div style={{width:"100%"}} className="nerdletOuterContainer">
                <Grid>
                    <GridItem columnSpan={11}>
                    <div style={{width:"100%"}} className="nerdletContainer">
                         <HeadingText type={HeadingText.TYPE.HEADING_2}>Time based availability</HeadingText>
                        <Grid>
                            {accountSelector}
                            {timeRangeDisplay}
                        </Grid>
                        {dataRender}
                    </div>
                                        
                    </GridItem>
                </Grid>  
        </div>
    }
}
