# Dundee Timetable Viewer

A local timetable clash checker for University of Dundee module data.

## Run

```bash
npm start
```

Open `http://localhost:3000`.

## Data

The app starts with sample data so the module picker and clash view can be tested immediately.

Use **Import** to paste timetable data as JSON, CSV, ICS, or Scientia list-view HTML. CSV columns can include:

```csv
module,module name,day,start,end,title,type,location,staff,weeks
CS10001,Example Module,Monday,09:00,10:00,Lecture,Lecture,QMB,,1-11
```

The **Fetch Dundee** button opens a local login prompt, then calls `https://timetable.dundee.ac.uk/Scientia/SWS/Dundee2627/` through the local server using HTTP Basic Auth. Credentials are used only for that request and are not stored by the app.

The scraper reads Dundee's module picker, then fetches each module's list-format timetable and converts the rows into the clash-checker view. Scraping all modules can take a few minutes because Scientia requires a separate ASP.NET postback flow per module.
