// Configuration options ----------------------------------

// Ingest API key and account ID (for recording data)
let INSIGHTS_WRITE_APIKEY="...FFFFNRAL" 
let INSIGHTS_WRITE_ACCOUNTID="12345" //(this is where the data goes)

// User API Key and account ID (for gathering data)
let GQL_APIKEY= "NRAK-..." 
let ACCOUNTID="12345" //(this is where the data comes from unless overidden)

//Restriction on which monitors to process (can be blank or any valid NRQL where clause)
const MONITOR_FILTER_CLAUSE="where monitorName='YourMonitorId'"; // e.g. "where monitorName='MyMonitorToProcess'"

// Other options
let SEND_DATA_TO_NR=true;    //if false data is processed but not recorded in New Relic
let NR_DATA_TABLE =  "syntheticTBABot"; //The event type to store the data
let ACCOUNT_NAME="Not Set" //


// End of configuration ---------------------------------

const axios = require('axios');
const moment = require('moment');

const STATES = {
    SUCCESS_NOTMUTED: 'SUCCESS_NOTMUTED',
    FAILED_NOTMUTED: 'FAILED_NOTMUTED',
    SUCCESS_MUTED: 'SUCCESS_MUTED',
    FAILED_MUTED: 'FAILED_MUTED',
    SUCCESS_UNKNOWN: 'SUCCESS_UNKNOWN',
    FAILED_UNKNOWN: 'FAILED_UNKNOWN',
  }


const formatDuration = (duration) => {
    return {
        duration: duration,
        human:      moment.duration(duration).humanize(),
        seconds:    Math.round(moment.duration(duration).asSeconds()),
        HHMMSS:     `${Math.floor(moment.duration(duration).asHours())}h ${moment.duration(duration).minutes()}m ${moment.duration(duration).seconds()}s`,
        DDHHMMSS:   `${Math.floor(moment.duration(duration).asDays())}d ${moment.duration(duration).hours()}h ${moment.duration(duration).minutes()}m ${moment.duration(duration).seconds()}s`
    }
}


exports.lambdaHandler = async (event) => {
  

    if(event) {
        if(event.insightsWriteAPIKey) {
            INSIGHTS_WRITE_APIKEY = event.insightsWriteAPIKey
        }
        if(event.insightsWriteAccountID) {
            INSIGHTS_WRITE_ACCOUNTID = event.insightsWriteAccountID
        }
        if(event.insightsReadAPIKey) {
            GQL_APIKEY = event.insightsReadAPIKey
        }
        if(event.insightsReadAccountID) {
            ACCOUNTID = event.insightsReadAccountID
        }
        if(event.insightsReadAccountName) {
            ACCOUNT_NAME = event.insightsReadAccountName
        }

        if(event.sendDataToNR===false) {
            SEND_DATA_TO_NR = false
        }
        if(event.NRDataTable) {
            NR_DATA_TABLE = NRDataTable
        }

    }
 
    if(event && event.processSynthetics===true ) {
        //by default we process yesterdays data for one day. but this can be overridden by the event to process a different date
        if(event.date) {
            console.log(`Processing data for ${event.date}`)
            await processSyntheticData(1,event.date)
        } else {
            console.log("Processing data for yesterday To run for a different day you must supply an event like { \"date\": \"20201101\"}")
            await processSyntheticData(1)
        }
    } else {
        console.log("Synthetic result data will not be processed on this run.")
    }

    if(event && event.processSummary===true ) {
        if(event.date) {
            console.log(`Generating summary data for ${event.date}`) 
            await processSummaryData(event.date)
        } else {
            console.log(`Generating summary data for yesterday`) 
            await processSummaryData(false)
        }
    } else {
        console.log("Summary data will not be processed on this run.")
    }
  
    return 'End of script reached.';
}

/*
* Send data back to NR via api
*/
async function sendDataToNR(eventType,data) {
    if(SEND_DATA_TO_NR) {
        let payload = data.map((element)=>{
            let event=element
            event.eventType=eventType
            return event
        })
        console.log(`Sending ${payload.length} events of type ${eventType} to NR`)
        await axios.post(`https://insights-collector.newrelic.com/v1/accounts/${INSIGHTS_WRITE_ACCOUNTID}/events`,
        payload
            ,{
            headers: {
                "Content-Type": "application/json",
                "X-Insert-Key": INSIGHTS_WRITE_APIKEY
            }
        })
        .then(function (response) {
            console.log(`NR ${eventType} response: ${response.status}`);
        })
        .catch(function (error) {
            console.log(error);
        });
    } else {
        console.log(`Data send to NR is skipped by configuration`)
    }
}


/*
* Generic GQL query
*/

async function NRGQLQuery(nrql,accountId,combineData=false) {

    let queryAcountID=accountId ? accountId : ACCOUNTID
    let nrqlBlock=""
    nrql.forEach((q)=>{
        nrqlBlock+= `
            ${q.label}: nrql(query: "${q.nrql}") { results }
        `
    })
    
    let gqlQuery=`
        {
            actor {
                account(id: ${queryAcountID}) {
                        ${nrqlBlock}
                }
            }
        }
    `
    //console.log(gqlQuery)

    const payload={ query: gqlQuery}
    let returnData=null
    await axios.post(`https://api.newrelic.com/graphql`,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'API-Key': GQL_APIKEY
                }
            }
        ).then(function (response) {
           // console.log(`GQL response status ${response.status}`);
           if(combineData===true) {
                let combinedData=[]
                for(let idx=0; idx < nrql.length; idx++) {
                    combinedData=[...combinedData, ...response.data.data.actor.account[nrql[idx].label].results ]
                }
                returnData=combinedData

           } else {
            returnData=response.data.data.actor.account
           }
          })
          .catch(function (error) {
              console.error("GQL response error")
            console.error(error);
          }); 

        return returnData
}


/*
* asyncForEach()
*
* A handy version of forEach that supports await.
* @param {Object[]} array     - An array of things to iterate over
* @param {function} callback  - The callback for each item
*/
async function asyncForEach(array, callback) {
    for (let index = 0; index < array.length; index++) {
      await callback(array[index], index, array);
    }
  }


/*
* processSummaryData()
*
* Proceses daily availability data to build monthly and weekly availability figures.
* @param {string} forDate  - The date to process, or false for default up to and including yesterday.
*/

async function processSummaryData(forDate) {
    let daysToConsider=28;
    let numberOfBatches=7;

    // let daysToConsider=1
    // let numberOfBatches=1

    let batchSize=daysToConsider/numberOfBatches 

    //calculate the period end. Summary data is calculated for 1 month and 1 week up until and including  this date
    let periodEnd=moment().utc().startOf('day').format('YYYYMMDD') //yesterday
    if(forDate) {
        periodEnd=moment(forDate, "YYYYMMDD").utc().format('YYYYMMDD') //if date supplied then that date itself should not be included.
    }


    //grab data for last 4 weeks in batches (note that data might not be in the week it was generated)
    let queries=[]
    for(let batch=0; batch < numberOfBatches; batch++) {
        const daysInABatch=batchSize
        let sinceDate=moment().add(1,'day').subtract(((batch+1)*daysInABatch),'day').utc().format('YYYY-MM-DD') //remember that todays data is yesterdays report so no need to offset 1 day to exlude today as it is inherent in the data :)
        let untilDate=moment().add(1,'day').subtract(((batch)*daysInABatch),'day').utc().format('YYYY-MM-DD') // but also remember until doesnt include tthe until date itself

        //gather the data using timeeries to get multiple day records - we only look at daily records with periodDurationDays = 1
        const qry=`SELECT latest(location) as location, latest(monitorId) as monitorId, latest(monitorName) as monitorName, latest(durationBreakdown) as durationBreakdown, latest(outageDurationHuman) as durationHuman, latest(durationSeconds) as durationSeconds,latest(durationMilliSeconds) as durationMilliSeconds, latest(percent) as percent, latest(count) as count, latest(periodEnd) as periodEnd, latest(periodStart) as periodStart, latest(timestamp) as timestamp, latest(state) as 'state' from ${NR_DATA_TABLE} since '${sinceDate}'  until '${untilDate}'  where periodDurationDays = 1  facet monitorId, state, location, periodStart limit max ${MONITOR_FILTER_CLAUSE} `
        queries.push({label: `batch_${batch}`, nrql: qry})
        //console.log(`Since: ${sinceDate}, Until ${untilDate} qry: ${qry}`);
    }
    const historicalDataDirty= await NRGQLQuery(queries,INSIGHTS_WRITE_ACCOUNTID,true) 
    const historicalData=historicalDataDirty.filter(e=>e.monitorName!=null) //remove null records casue by monitors not running in bucket

    //gather list of all available monitors
    const monitorList = await NRGQLQuery([{label: "data", nrql: `SELECT count(*) as checks, latest(monitorName) as monitorName, latest(monitorId) as monitorId, uniqueCount(location) as locations from SyntheticCheck facet monitorId since 29 days ago until 1 day ago limit max  ${MONITOR_FILTER_CLAUSE}`}],ACCOUNTID,true)

    let monitorData=monitorList.map((monitor,idx)=>{
        console.log(`Processing monitor: ${monitor.monitorName}` );
        let data={ ...monitor }

        data.historical=historicalData.filter((e)=>{return e.monitorId==monitor.monitorId})

        data.metrics={}

    
        const dataSTATES=[...Object.values(STATES), "SUMMARY", "OVERLAP"]
        // dataSTATES.forEach(state => {
        //     data.metrics[state]={
        //         week: { reportDays: 0, seconds: 0, milliseconds: 0, percent:0, count: 0},
        //         month: { reportDays: 0, seconds: 0, milliseconds: 0, percent:0, count: 0}
        //     }
        //   });

        data.historical.forEach((outage)=>{
            if(dataSTATES.includes(outage.state)) {

                if(!data.metrics[outage.state]) {
                    data.metrics[outage.state]={};
                }

                if(!data.metrics[outage.state][outage.location]) {
                    data.metrics[outage.state][outage.location]={
                                week: { reportDays: 0, seconds: 0, milliseconds: 0, percent:0, count: 0},
                                month: { reportDays: 0, seconds: 0, milliseconds: 0, percent:0, count: 0}
                            };
                }

                let startOfToday = moment(periodEnd, "YYYYMMDD").utc().startOf('day');
                let twentyEightDaysAgo=moment().utc().subtract(29,'day').startOf('day');
                if(!twentyEightDaysAgo.isAfter(outage.periodStart) && startOfToday.isAfter(outage.periodStart)) {
                    data.metrics[outage.state][outage.location].month.reportDays=data.metrics[outage.state][outage.location].month.reportDays+1;
                    data.metrics[outage.state][outage.location].month.seconds=data.metrics[outage.state][outage.location].month.seconds+outage.durationSeconds;
                    data.metrics[outage.state][outage.location].month.milliseconds=data.metrics[outage.state][outage.location].month.milliseconds+outage.durationMilliSeconds;
                    data.metrics[outage.state][outage.location].month.count=data.metrics[outage.state][outage.location].month.count+outage.count;
                }
               
                let sevenDaysAgo=moment().utc().subtract(8,'day').startOf('day');
                if(!sevenDaysAgo.isAfter(outage.periodStart) &&  startOfToday.isAfter(outage.periodStart)) {
                    data.metrics[outage.state][outage.location].week.reportDays=data.metrics[outage.state][outage.location].week.reportDays+1;
                    data.metrics[outage.state][outage.location].week.seconds=data.metrics[outage.state][outage.location].week.seconds+outage.durationSeconds;
                    data.metrics[outage.state][outage.location].week.milliseconds=data.metrics[outage.state][outage.location].week.milliseconds+outage.durationMilliSeconds;
                    data.metrics[outage.state][outage.location].week.count=data.metrics[outage.state][outage.location].week.count+outage.count;
                } 
            }

        });

        Object.keys(data.metrics).forEach(state => {
            Object.keys(data.metrics[state]).forEach((location)=> {
       
                const periodMonthSeconds = 60 * 60 * 24 * data.metrics[state][location].month.reportDays; //seconds in a month (that had reported data)
                data.metrics[state][location].month.percent= (( data.metrics[state][location].month.milliseconds / (periodMonthSeconds * 1000)) *100);
        
                const periodWeekSeconds = 60 * 60 * 24  * data.metrics[state][location].week.reportDays //seconds in a week (that had reported data)
                data.metrics[state][location].week.percent= (( data.metrics[state][location].week.milliseconds / (periodWeekSeconds* 1000)) *100)
        
                //generate formatted data strings
                const monthFormatted=formatDuration(data.metrics[state][location].month.milliseconds);
                data.metrics[state][location].month.durationBreakdown=monthFormatted.DDHHMMSS;
                data.metrics[state][location].month.durationHuman=monthFormatted.human;
                
                const weekFormatted=formatDuration(data.metrics[state][location].week.milliseconds);
                data.metrics[state][location].week.durationBreakdown=weekFormatted.DDHHMMSS;
                data.metrics[state][location].week.durationHuman=weekFormatted.human;
            })
        });
        return data
    })


    await asyncForEach(monitorData,async (monitor)=>{
        let  ingestPayload=[];
        Object.keys(monitor.metrics).forEach((state)=>{
            const stateData=monitor.metrics[state];
            Object.keys(stateData).forEach((location)=>{
                Object.keys(stateData[location]).forEach(period => {
                    const periodData=stateData[location][period];

                    ingestPayload.push({
                        monitorId: monitor.monitorId,
                        monitorName: monitor.monitorName,
                        location: location,
                        sourceAccountId: ACCOUNTID, //"accountId" is reserved 
                        accountName: ACCOUNT_NAME,
                        checks: monitor.checks,
                        state: state,
                        period: period,
                        periodEnd: moment(periodEnd, "YYYYMMDD").utc().format("YYYY-MM-DD"),
                        periodEndUnix: moment(periodEnd, "YYYYMMDD").utc().unix(),
                        reportDays: periodData.reportDays,
                        seconds: periodData.seconds,
                        milliseconds: periodData.milliseconds,
                        percent: periodData.percent,
                        count: periodData.count,
                        durationBreakdown: periodData.durationBreakdown,
                        durationHuman: periodData.durationHuman
                    });
                });
              
            });
        });
       
        await sendDataToNR(NR_DATA_TABLE+"Summary",ingestPayload);
    
    });

}



/*
* processSyntheticData()
*
* Proceses synthetic result data to determine outtages
* @param {int} days        - The number of days back to consider (usually 1)
* @param {string} forDate  - The date to process
*/
async function processSyntheticData(days,forDate) {

    console.log(`Retrieving data for ${days} days(s) for ${forDate ? forDate : "since today"}`)

    let restrictedMonitorClause = MONITOR_FILTER_CLAUSE; // could put a where clause here to reduce number of monitors
    let daysLookback = days+1           //number of days to consider (remembering to skip today)
    let dataDaysLookBack = daysLookback-1

    //get a list of monitors
    const monitors= await NRGQLQuery([{label:'data', nrql: `FROM SyntheticCheck select count(*) as 'failures', latest(monitorName) as 'monitorName', uniqueCount(location) as locations, filter(uniqueCount(location),where result='FAILED') as failedLocations facet monitorId since ${daysLookback} day ago ${restrictedMonitorClause} limit max`}] ) 

    //filter out monitors that have not failed in all locations
    //TODO - review this, it was originally fixed to only consider those with >1 location
    const candidateMonitors= monitors.data.results;
    //console.log(candidateMonitors)


    //Gather the data for each monitor 
    let monitorData=[]
    await asyncForEach(candidateMonitors,async (monitor)=>{
        console.log(`Querying data for monitor: '${monitor.monitorName}'`)
        //grab the list of locations for the monitor
        const locationsData= await NRGQLQuery([{label: 'data', nrql: `FROM SyntheticCheck select uniques(location) as location since ${daysLookback} day ago where monitorId='${monitor.monitorId}' ${restrictedMonitorClause}`}])  
        const locations=locationsData.data.results
        const locationsArray=locations[0] && locations[0].location ? locations[0].location : []

        let thisMonitorData={ name: monitor.monitorName, id: monitor.monitorId, locations:{} }

        //Break up into daily queries for each monitor (note that today isnt included so that only full days are considered)
        let numberPromises=dataDaysLookBack !== undefined ? dataDaysLookBack: 1
        if(dataDaysLookBack===0) {numberPromises=1}

        for (let dayIndex=0; dayIndex < numberPromises; dayIndex++) {

            let startDate, endDate
            if(forDate) { //we have a set start date, use this as start point
                let initStartDate=moment(forDate, "YYYYMMDD").utc().add(1,'day')
                let initEndDate=moment(forDate, "YYYYMMDD").utc().add(1,'day')
                startDate=initStartDate.subtract(dayIndex+1,'day').utc().format('YYYY-MM-DD')
                endDate=initEndDate.subtract(dayIndex,'day').utc().format('YYYY-MM-DD')
            } else { //we dont have a set start date, assume today
                if(dataDaysLookBack===0 ) {
                    //special caset o scan todays data, for testing mainly
                    startDate=moment().utc().format('YYYY-MM-DD')
                    endDate=moment().add(1,'day').utc().format('YYYY-MM-DD')
                }else {
                    startDate=moment().subtract(dayIndex+1,'day').utc().format('YYYY-MM-DD')
                    endDate=moment().subtract(dayIndex,'day').utc().format('YYYY-MM-DD')
                }
                
                
            }
 
            let synthResultNRQL=`FROM SyntheticCheck select location, result, custom.muteStatus  as muteStatus where monitorId='${monitor.monitorId}' limit max`
            let synthQueries = locationsArray.map((loc)=>{
                return { label: `queryData_${dayIndex}_${loc}`, nrql: `${synthResultNRQL} where location='${loc}' since '${startDate}' until '${endDate}' with timezone 'UTC'`}
            })

            let synthData=await NRGQLQuery(synthQueries)
            //combine all the location data for this day into a single array rather than seperated out by location
            let combinedSynthData=[]
            locationsArray.forEach((loc)=>{
                combinedSynthData=[...combinedSynthData, ...synthData[`queryData_${dayIndex}_${loc}`].results ]
            })
        
            // initiate blended location
            thisMonitorData.locations["blended"]={rawResults: []};

            //Add the data from this day to the accumulative monitor data
            combinedSynthData.forEach((check)=>{
                if(!thisMonitorData.locations[check.location]) {
                    thisMonitorData.locations[check.location]={rawResults: []}
                }
                thisMonitorData.locations[check.location].rawResults.push({result: check.result, muteStatus: check.muteStatus,timestamp:check.timestamp});
                thisMonitorData.locations["blended"].rawResults.push({result: check.result, muteStatus: check.muteStatus,timestamp:check.timestamp});
            })
            //sort the records so that the oldest come first
            Object.keys(thisMonitorData.locations).forEach((location)=>{
                thisMonitorData.locations[location].rawResults.sort((a,b)=>{ return a.timestamp > b.timestamp ? 1 : -1})
            })
        }
        monitorData.push(thisMonitorData)
    })

    console.log(`Monitor data retrieved for ${monitorData.length} monitors`)
   // console.log(JSON.stringify(monitorData));

    //search for all outtage windows by location
    monitorData.forEach(monitor=>{
        for(const loc in monitor.locations) {
            monitor.locations[loc].downPeriods=[]
            monitor.locations[loc].statePeriods=[];
            let lastFailureStart=0
            let currentlyFailed = false

            let currentState=STATES.SUCCESS_NOTMUTED; //we start from an assumed good state.
            let lastStateStart=null;

            monitor.locations[loc].rawResults.forEach((check,idx)=>{

                if(lastStateStart === null) { 
                    lastStateStart=moment(check.timestamp).utc().startOf('day').valueOf(); //first result should be padded out to start of day
                } 
                

                //set the monitors first and last timestamps
                if(check.timestamp < monitor.firstEntry || monitor.firstEntry === undefined ) {
                    monitor.firstEntry = check.timestamp
                }
                if(check.timestamp > monitor.lastEntry || monitor.lastEntry === undefined ) {
                    monitor.lastEntry = check.timestamp
                }


                // Find all state windows
                let checkState=check.result;
                if(check.muteStatus===null ) {
                    checkState+="_NOTMUTED";
                } else {
                    checkState+="_"+check.muteStatus;
                }

                if(checkState!==currentState || idx == (monitor.locations[loc].rawResults.length-1)) { //ensure the last entry triggers a closure too regarldess of its result

                    let endTimestamp=check.timestamp;
                    if(idx == (monitor.locations[loc].rawResults.length-1)) {
                        endTimestamp=moment(check.timestamp).utc().endOf('day').valueOf() + 1; //last check of the day? then pad out to end of day.
                    }
                    const duration=endTimestamp-lastStateStart;
                    monitor.locations[loc].statePeriods.push({start: lastStateStart, end: check.timestamp, duration: duration, state: currentState}); //record the previous state
                    //console.log(`State changed from ${currentState} to ${checkState} logging previous with ${moment.duration(duration).humanize() } duration `);

                    //reset pointers
                    lastStateStart=check.timestamp;
                    currentState=checkState;
                }
            })
        }
    })


    //find *complete* outage periods by matching each location with all the others exhaustively 
    monitorData.forEach(monitor=>{
        monitor.overlapPeriods=[]
        let locations = Object.keys(monitor.locations)
        for (const location of locations.filter((l)=>{return l != "blended"})) { //the blended location is ignored for multi-location overlap
            let otherLocations=locations.filter(loc=>{return loc!=location}) // remove the current location from list of others
            
            monitor.locations[location].statePeriods.forEach((period)=>{ //iterate over this locations outages and search for overlaps in others
                if([STATES.FAILED_MUTED,STATES.FAILED_NOTMUTED,STATES.FAILED_UNKNOWN].includes(period.state)) {
                    let latestStart=period.start
                    let earliestEnd=period.end
                    let locationsWithOverlap=1
                    for(const loc of otherLocations) {
                        let overlapPresent=false //there might be more than one overlap
                        for(const comparePeriod of monitor.locations[loc].statePeriods){
                            if([STATES.FAILED_MUTED,STATES.FAILED_NOTMUTED,STATES.FAILED_UNKNOWN].includes(comparePeriod.state)) {
                                if(comparePeriod.start <= earliestEnd &&  comparePeriod.end >= latestStart) {
                                        latestStart = (comparePeriod.start > latestStart && comparePeriod.start <= earliestEnd) ? comparePeriod.start : latestStart
                                        earliestEnd = (comparePeriod.end < earliestEnd &&  comparePeriod.end >= latestStart)? comparePeriod.end : earliestEnd
                                        overlapPresent=true
                                }
                            }
                        }
                        if(overlapPresent) {locationsWithOverlap++}
                    }
    
                    if(locationsWithOverlap >= locations.length) { //we only consider it an outtge if all locations are failing
                        monitor.overlapPeriods.push({start:latestStart, end:earliestEnd, duration: earliestEnd-latestStart})
                    }
                }

            })
        }
    })


    //------ At this point all the data is loaded and outtages identified processed ----


    let NRPayload=[]
    //Calculate data for each monitor
    monitorData.forEach((monitor)=>{
        console.log(`\n\n=== Monitor: ${monitor.name} ===`)
        
        //mutli location overlap calculations -------------------------------------
        let totalOverlapOutageDuration=0
        //there will be duplictae overlaps, remove the duplicates them and sort by end time!
        const dedupeOverlapPeriods = monitor.overlapPeriods.filter((v,i,a)=>a.findIndex(t=>(t.start === v.start && t.end===v.end))===i)
        const dedupeOverlapPeriodsSorted=dedupeOverlapPeriods.sort((a,b)=>{ return a.end > b.end ? -1 : 1})

        console.log(`Number of overlap periods: ${dedupeOverlapPeriodsSorted.length}`)
        dedupeOverlapPeriodsSorted.forEach((outage,idx)=>{
            totalOverlapOutageDuration+=outage.duration
            // let durationHuman=moment.duration(outage.duration).humanize()
            // let durationSeconds=moment.duration(outage.duration).asSeconds()
            // console.log(`${idx}: ${moment.unix(outage.start/1000).format("YYYY-MM-DD HH:mm")} to ${moment.unix(outage.end/1000).format("YYYY-MM-DD HH:mm")} Duration: ${durationHuman} (${durationSeconds} seconds)`)
        })


        //individual location calculations (including mute status) --------------------------

        const LocationSummary=[]
        let locations = Object.keys(monitor.locations);
        console.log(`Number of locations: ${locations.length}`);
        for (const location of locations) {
            let statePeriods=monitor.locations[location].statePeriods;
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
              })
              LocationSummary.push({
                location: location, 
                successDuration: STATE_DURATIONS.SUCCESS_NOTMUTED + STATE_DURATIONS.SUCCESS_MUTED + STATE_DURATIONS.SUCCESS_UNKNOWN,
                failedDuration: STATE_DURATIONS.FAILED_NOTMUTED + STATE_DURATIONS.FAILED_MUTED + STATE_DURATIONS.FAILED_UNKNOWN,
                totalDurations: STATE_DURATIONS.SUCCESS_NOTMUTED + STATE_DURATIONS.SUCCESS_MUTED + STATE_DURATIONS.SUCCESS_UNKNOWN + STATE_DURATIONS.FAILED_NOTMUTED + STATE_DURATIONS.FAILED_MUTED + STATE_DURATIONS.FAILED_UNKNOWN,
                failedCount: STATE_COUNTS.FAILED_NOTMUTED + STATE_COUNTS.FAILED_MUTED + STATE_COUNTS.FAILED_UNKNOWN,
                successCount: STATE_COUNTS.SUCCESS_NOTMUTED + STATE_COUNTS.SUCCESS_MUTED + STATE_COUNTS.SUCCESS_UNKNOWN,
                states: STATE_DURATIONS,
                counts: STATE_COUNTS
            });
        }


        // putting it all together

        let msForPeriod=dataDaysLookBack*24*60*60*1000;
        if(dataDaysLookBack == 0) { //special case if look back is zero days, the milliseconds for today we need to calculate. this really is only for testing
            let now= moment();
            let startOfDay=now.clone().startOf('day');
            let duration=moment.duration(now.diff(startOfDay))
            msForPeriod=duration.asMilliseconds()
        }

        let overlapPercentAvailable=((totalOverlapOutageDuration/msForPeriod)*100);
        let totalOverlapOutageDurationFormatted = formatDuration(totalOverlapOutageDuration);
        console.log(`Total overlap outage duration: ${totalOverlapOutageDurationFormatted.human} (${totalOverlapOutageDurationFormatted.DDHHMMSS} or ${totalOverlapOutageDurationFormatted.seconds} seconds`)
        console.log(`Total overlap percent unavailable: ${overlapPercentAvailable.toFixed(2)}%`)

        NRPayload.push({
                "monitorName": monitor.name,
                "monitorId": ""+monitor.id,
                "count":dedupeOverlapPeriodsSorted.length,
                "durationMilliSeconds": totalOverlapOutageDurationFormatted.duration,
                "durationSeconds":  totalOverlapOutageDurationFormatted.seconds,
                "durationBreakdown": totalOverlapOutageDurationFormatted.DDHHMMSS,
                "durationHuman": totalOverlapOutageDurationFormatted.human,
                "percent": overlapPercentAvailable,
                "location": "ALL",
                "locationCount": LocationSummary.length,
                "state": "OVERLAP"
        })
      
        

        LocationSummary.forEach((location)=>{
            console.log(`\n=== Location: ${location.location}`);
            let percentAvailable = ((location.failedDuration/msForPeriod)*100);

            const formattedFailedDuration = formatDuration(location.failedDuration);

            //summry for location ignores mute status, this is a summary of failures
            NRPayload.push({
                "monitorName": monitor.name,
                "monitorId": ""+monitor.id,
                "count":location.failedCount,
                "durationMilliSeconds": formattedFailedDuration.duration,
                "durationSeconds":  formattedFailedDuration.seconds,
                "durationBreakdown": formattedFailedDuration.DDHHMMSS,
                "durationHuman": formattedFailedDuration.human,
                "percent": percentAvailable,
                "location": location.location,
                "state": "SUMMARY"
             });
            console.log(`Combined failures: ${location.failedCount} total failures: ${formattedFailedDuration.DDHHMMSS} (${percentAvailable.toFixed(2)}%)` )


             Object.keys(location.states).forEach((state)=>{

                const formattedDuration = formatDuration(location.states[state])
                const percent = ((location.states[state]/msForPeriod)*100);
                NRPayload.push({
                    "monitorName": monitor.name,
                    "monitorId": ""+monitor.id,
                    "count":location.counts[state],
                    "durationMilliSeconds": formattedDuration.duration,
                    "durationSeconds":  formattedDuration.seconds,
                    "durationBreakdown": formattedDuration.DDHHMMSS,
                    "durationHuman": formattedDuration.human,
                    "percent": percent,
                    "location": location.location,
                    "state": state
                 });
                 console.log(`${state}: ${location.counts[state]} occurrences: ${formattedDuration.DDHHMMSS} (${percent.toFixed(2)}%)` )

             })
        
        });
    }) 

    //Report to New Relic
    let lastDate, firstDate
    if(forDate) { //we have a set start date
        let initStartDate=moment(forDate, "YYYYMMDD").utc().add(1,'day')
        let initEndDate=moment(forDate, "YYYYMMDD").utc().add(1,'day')
        lastDate=initStartDate.subtract(1,'day').utc().format('YYYY-MM-DD')
        firstDate=initEndDate.subtract(days,'day').utc().format('YYYY-MM-DD')
    } else { //we dont have a set start date, assume today
        if(days===0 ) {
            //special caset to scan todays data, for testing mainly
            lastDate=moment().utc().format('YYYY-MM-DD')
            firstDate=moment().add(1,'day').utc().format('YYYY-MM-DD')
        } else {
            lastDate=moment().subtract(1,'day').utc().format('YYYY-MM-DD')
            firstDate=moment().subtract(days,'day').utc().format('YYYY-MM-DD')
        }
        
    }
    let NRExtendedPayload = NRPayload.map((element)=>{
        element.periodEnd=lastDate
        element.periodStart=firstDate
        element.periodDurationDays=days
        element.periodDurationSeconds=days*24*60*60
        return element
    })


    console.log(`Report to new relic ${lastDate} to ${firstDate}`)
    await sendDataToNR(NR_DATA_TABLE,NRExtendedPayload)

}



// -------------------
// If run outside of a lambda then this calls the script

const run = async () => {

    await processSyntheticData(1);      // process last days data
    await processSummaryData(false);    // generate summary
    

    // await processSyntheticData(1,'20240702'); // re-run for specific date (or rather the day before!)
    // await processSyntheticData(1,'20240701');
    // await processSyntheticData(1,'20240630');
    // await processSummaryData(false); 

}

run().then(()=>{
    console.log("done");
});