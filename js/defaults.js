export const DEFAULTS = {
  settings: {
    primaryCurrency: 'TWD',
    investmentCurrency: 'USD',
    forecastSalary: 82500,
    tithePercent: 10,
    operatingBuffer: 3000,
    emergencyTarget: 300000,
    wealthRaisePercent: 75,
    usdTwdRate: 31.78,
    lastBackupAt: null,
    dataModelVersion: 132
  },
  accounts: [
    {id:'ctbc', name:'CTBC Operating', type:'checking', role:'operating', currency:'TWD', openingBalance:34850, active:true},
    {id:'esun', name:'E.SUN Reserved', type:'savings', role:'reserved', currency:'TWD', openingBalance:55000, active:true},
    {id:'ibkr', name:'IBKR', type:'brokerage', role:'investment', currency:'USD', openingBalance:3536, active:true}
  ],
  buckets: [
    {id:'tithe', name:'Tithe', accountId:'esun', bucketType:'restricted', openingBalance:55000, countsTowardCoreWealth:false, countsTowardNetWorth:false, active:true},
    {id:'emergency', name:'Emergency Fund', accountId:'esun', bucketType:'core_wealth', openingBalance:0, countsTowardCoreWealth:true, countsTowardNetWorth:true, active:true},
    {id:'electricity', name:'Electricity Reserve', accountId:'ctbc', bucketType:'operating_reserve', openingBalance:0, countsTowardCoreWealth:false, countsTowardNetWorth:false, active:true},
    {id:'home-trip', name:'Home Travel Fund', accountId:'esun', bucketType:'sinking_fund', openingBalance:0, countsTowardCoreWealth:false, countsTowardNetWorth:true, active:true},
    {id:'equipment', name:'Equipment Fund', accountId:'esun', bucketType:'sinking_fund', openingBalance:0, countsTowardCoreWealth:false, countsTowardNetWorth:true, active:true}
  ],
  categories: [
    {id:'tithe-cat', name:'Tithe', group:'Giving', ruleType:'percentage', defaultAmount:10, active:true, sort:1},
    {id:'rent', name:'Rent', group:'Fixed', ruleType:'fixed', defaultAmount:23000, active:true, sort:10},
    {id:'sister-rent', name:"Sister's Rent", group:'Fixed', ruleType:'fixed', defaultAmount:7600, active:true, sort:11},
    {id:'family-support', name:'Family Support', group:'Fixed', ruleType:'fixed', defaultAmount:3500, active:true, sort:12},
    {id:'sim', name:'SIM', group:'Fixed', ruleType:'fixed', defaultAmount:799, active:true, sort:13},
    {id:'wifi', name:'Wi-Fi', group:'Fixed', ruleType:'fixed', defaultAmount:899, active:true, sort:14},
    {id:'gym', name:'Gym', group:'Fixed', ruleType:'fixed', defaultAmount:1088, active:true, sort:15},
    {id:'apple-one', name:'Apple One', group:'Fixed', ruleType:'fixed', defaultAmount:390, active:true, sort:16},
    {id:'icloud', name:'iCloud', group:'Fixed', ruleType:'fixed', defaultAmount:300, active:true, sort:17},
    {id:'food', name:'Food', group:'Flexible', ruleType:'cap', defaultAmount:10000, active:true, sort:30},
    {id:'dating-social', name:'Dating / Social', group:'Flexible', ruleType:'cap', defaultAmount:3000, active:true, sort:31},
    {id:'transport', name:'Transportation', group:'Flexible', ruleType:'cap', defaultAmount:1100, active:true, sort:32},
    {id:'gas', name:'Gas', group:'Flexible', ruleType:'cap', defaultAmount:200, active:true, sort:33},
    {id:'water', name:'Water', group:'Flexible', ruleType:'cap', defaultAmount:400, active:true, sort:34},
    {id:'misc', name:'Miscellaneous', group:'Flexible', ruleType:'cap', defaultAmount:1000, active:true, sort:35},
    {id:'electricity-contrib', name:'Electricity Reserve', group:'Reserve', ruleType:'sinking_contribution', defaultAmount:4400, bucketId:'electricity', active:true, sort:50},
    {id:'operating-buffer', name:'Operating Buffer', group:'Buffer', ruleType:'buffer', defaultAmount:3000, active:true, sort:60},
    {id:'electricity-bill', name:'Electricity Bill', group:'Reserved Expense', ruleType:'expense_only', defaultAmount:0, defaultFundingBucketId:'electricity', active:true, sort:70},
    {id:'travel-expense', name:'Travel Expense', group:'Reserved Expense', ruleType:'expense_only', defaultAmount:0, defaultFundingBucketId:'home-trip', active:true, sort:71},
    {id:'equipment-purchase', name:'Equipment Purchase', group:'Reserved Expense', ruleType:'expense_only', defaultAmount:0, defaultFundingBucketId:'equipment', active:true, sort:72}
  ],
  goals: [
    {id:'goal-emergency', name:'Emergency Fund', type:'core_wealth', targetAmount:300000, bucketId:'emergency', targetDate:null, priority:1, status:'active', prerequisiteGoalId:null, prerequisiteAmount:0, monthlyTarget:null},
    {id:'goal-home-trip', name:'Home Travel', type:'sinking_fund', targetAmount:100000, bucketId:'home-trip', targetDate:'2027-12-31', priority:2, status:'waiting', prerequisiteGoalId:'goal-emergency', prerequisiteAmount:200000, monthlyTarget:10000},
    {id:'goal-equipment', name:'Equipment Fund', type:'sinking_fund', targetAmount:40000, bucketId:'equipment', targetDate:null, priority:3, status:'paused', prerequisiteGoalId:null, prerequisiteAmount:0, monthlyTarget:null}
  ]
};

export const INCOME_TYPES = [
  ['regular_income','Regular Income'],['bonus','Bonus'],['reimbursement','Reimbursement'],
  ['asset_sale','Asset Sale'],['gift_windfall','Gift / Windfall'],['other_income','Other Income']
];
