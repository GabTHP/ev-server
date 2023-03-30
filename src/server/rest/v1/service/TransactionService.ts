import { Action, Entity } from '../../../../types/Authorization';
import ChargingStation, { Connector } from '../../../../types/ChargingStation';
import { HTTPAuthError, HTTPError } from '../../../../types/HTTPError';
import { NextFunction, Request, Response } from 'express';
import Tenant, { TenantComponents } from '../../../../types/Tenant';
import Transaction, { AdvenirConsumptionData, AdvenirEvseData, AdvenirPayload, AdvenirTransactionData, TransactionStatus } from '../../../../types/Transaction';

import { ActionsResponse } from '../../../../types/GlobalType';
import AppAuthError from '../../../../exception/AppAuthError';
import AppError from '../../../../exception/AppError';
import AuthorizationService from './AuthorizationService';
import Authorizations from '../../../../authorization/Authorizations';
import BillingFactory from '../../../../integration/billing/BillingFactory';
import { BillingStatus } from '../../../../types/Billing';
import ChargingStationService from './ChargingStationService';
import ChargingStationStorage from '../../../../storage/mongodb/ChargingStationStorage';
import ChargingStationValidatorRest from '../validator/ChargingStationValidatorRest';
import Configuration from '../../../../utils/Configuration';
import Constants from '../../../../utils/Constants';
import Consumption from '../../../../types/Consumption';
import ConsumptionStorage from '../../../../storage/mongodb/ConsumptionStorage';
import CpoOCPIClient from '../../../../client/ocpi/CpoOCPIClient';
import { DataResult } from '../../../../types/DataResult';
import { HttpTransactionsGetRequest } from '../../../../types/requests/HttpTransactionRequest';
import Logging from '../../../../utils/Logging';
import LoggingHelper from '../../../../utils/LoggingHelper';
import OCPIClientFactory from '../../../../client/ocpi/OCPIClientFactory';
import OCPIFacade from '../../../ocpi/OCPIFacade';
import { OCPIRole } from '../../../../types/ocpi/OCPIRole';
import OCPPService from '../../../../server/ocpp/services/OCPPService';
import OCPPUtils from '../../../ocpp/utils/OCPPUtils';
import OICPFacade from '../../../oicp/OICPFacade';
import RefundFactory from '../../../../integration/refund/RefundFactory';
import { RefundStatus } from '../../../../types/Refund';
import RoamingUtils from '../../../../utils/RoamingUtils';
import { ServerAction } from '../../../../types/Server';
import SynchronizeRefundTransactionsTask from '../../../../scheduler/tasks/SynchronizeRefundTransactionsTask';
import TagStorage from '../../../../storage/mongodb/TagStorage';
import TransactionStorage from '../../../../storage/mongodb/TransactionStorage';
import TransactionValidatorRest from '../validator/TransactionValidatorRest';
import UserToken from '../../../../types/UserToken';
import Utils from '../../../../utils/Utils';
import UtilsService from './UtilsService';
import moment from 'moment-timezone';
import I18nManager from '../../../../utils/I18nManager';
import PDFDocument from 'pdfkit'
import fs from 'fs'

const MODULE_NAME = 'TransactionService';

export default class TransactionService {
  public static async handleGetTransactions(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsGetReq(req.query);
    // Get Transactions
    const transactions = await TransactionService.getTransactions(req, filteredRequest);
    res.json(transactions);
    next();
  }

  public static async handleSynchronizeRefundedTransactions(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.REFUND,
      Action.REFUND_TRANSACTION, Entity.TRANSACTION, MODULE_NAME, 'handleSynchronizeRefundedTransactions');
    // Check dynamic auth
    await AuthorizationService.checkAndGetTransactionsAuthorizations(req.tenant, req.user, Action.SYNCHRONIZE_REFUNDED_TRANSACTION);
    try {
      const task = new SynchronizeRefundTransactionsTask();
      await task.processTenant(req.tenant, null);
      const response: any = {
        ...Constants.REST_RESPONSE_SUCCESS,
      };
      res.json(response);
      next();
    } catch (error) {
      await Logging.logActionExceptionMessageAndSendResponse(action, error, req, res, next);
    }
  }

  public static async handleRefundTransactions(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.REFUND,
      Action.REFUND_TRANSACTION, Entity.TRANSACTION, MODULE_NAME, 'handleRefundTransactions');
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsByIDsGetReq(req.body);
    const transactionsToRefund: Transaction[] = [];
    for (const transactionId of filteredRequest.transactionsIDs) {
      // Check dynamic auth
      const transaction = await UtilsService.checkAndGetTransactionAuthorization(req.tenant, req.user, transactionId,
        Action.REFUND_TRANSACTION, action, null, { withUser: true }, true);
      transactionsToRefund.push(transaction);
    }
    const refundConnector = await RefundFactory.getRefundImpl(req.tenant);
    if (!refundConnector) {
      throw new AppError({
        errorCode: HTTPError.GENERAL_ERROR,
        message: 'No Refund Implementation Found',
        module: MODULE_NAME, method: 'handleRefundTransactions',
        user: req.user, action
      });
    }
    // Check user connection
    try {
      await refundConnector.checkConnection(req.user.id);
    } catch (error) {
      throw new AppError({
        errorCode: HTTPError.REFUND_CONNECTION_ERROR,
        message: 'No Refund valid connection found',
        module: MODULE_NAME, method: 'handleRefundTransactions',
        user: req.user, action
      });
    }
    // Refund
    const refundedTransactions = await refundConnector.refund(req.user.id, transactionsToRefund);
    const response: any = {
      ...Constants.REST_RESPONSE_SUCCESS,
      inSuccess: refundedTransactions.length
    };
    // Send result
    const notRefundedTransactions = transactionsToRefund.length - refundedTransactions.length;
    if (notRefundedTransactions > 0) {
      response.inError = notRefundedTransactions;
    }
    res.json(response);
    next();
  }

  public static async handlePushTransactionCdr(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    if (!Utils.isComponentActiveFromToken(req.user, TenantComponents.OCPI) &&
        !Utils.isComponentActiveFromToken(req.user, TenantComponents.OICP)) {
      throw new AppAuthError({
        errorCode: HTTPAuthError.FORBIDDEN,
        entity: Entity.TRANSACTION, action: Action.PUSH_TRANSACTION_CDR,
        module: MODULE_NAME, method: 'handlePushTransactionCdr',
        inactiveComponent: `${TenantComponents.OCPI}, ${TenantComponents.OICP}` as TenantComponents,
        user: req.user
      });
    }
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionCdrPushReq(req.body);
    // Check Transaction
    const transaction = await UtilsService.checkAndGetTransactionAuthorization(req.tenant, req.user, filteredRequest.transactionId,
      Action.PUSH_TRANSACTION_CDR, action, null, { withUser: true, withTag: true });
    // Check Charging Station
    const chargingStation = await UtilsService.checkAndGetChargingStationAuthorization(
      req.tenant, req.user, transaction.chargeBoxID, Action.PUSH_TRANSACTION_CDR, action, null, { withSiteArea: true });
    if (!chargingStation.public) {
      throw new AppError({
        ...LoggingHelper.getTransactionProperties(transaction),
        errorCode: HTTPError.GENERAL_ERROR,
        message: `${Utils.buildConnectorInfo(transaction.connectorId, transaction.id)} Charging Station is not public`,
        module: MODULE_NAME, method: 'handlePushTransactionCdr',
        user: req.user, action
      });
    }
    if (chargingStation.siteArea && !chargingStation.siteArea.accessControl) {
      throw new AppError({
        ...LoggingHelper.getTransactionProperties(transaction),
        errorCode: HTTPError.GENERAL_ERROR,
        message: `${Utils.buildConnectorInfo(transaction.connectorId, transaction.id)} Charging Station access control is inactive on Site Area '${chargingStation.siteArea.name}'`,
        module: MODULE_NAME, method: 'handlePushTransactionCdr',
        user: req.user, action
      });
    }
    // No Roaming Cdr to push
    if (!transaction.oicpData?.session && !transaction.ocpiData?.session) {
      throw new AppError({
        ...LoggingHelper.getTransactionProperties(transaction),
        errorCode: HTTPError.TRANSACTION_WITH_NO_OCPI_DATA,
        message: `${Utils.buildConnectorInfo(transaction.connectorId, transaction.id)} No OCPI or OICP Session data`,
        module: MODULE_NAME, method: 'handlePushTransactionCdr',
        user: req.user, action
      });
    }
    // Check OCPI
    if (transaction.ocpiData?.session) {
      // CDR already pushed
      if (transaction.ocpiData.cdr?.id) {
        throw new AppError({
          ...LoggingHelper.getTransactionProperties(transaction),
          errorCode: HTTPError.TRANSACTION_CDR_ALREADY_PUSHED,
          message: `The CDR of the Transaction ID '${transaction.id}' has already been pushed`,
          module: MODULE_NAME, method: 'handlePushTransactionCdr',
          user: req.user, action
        });
      }
      // OCPI: Post the CDR
      const ocpiCdrSent = await OCPIFacade.checkAndSendTransactionCdr(
        req.tenant, transaction, chargingStation, chargingStation.siteArea, action);
      if (!ocpiCdrSent) {
        throw new AppError({
          ...LoggingHelper.getTransactionProperties(transaction),
          errorCode: HTTPError.GENERAL_ERROR,
          message: `The CDR of the Transaction ID '${transaction.id}' has not been sent`,
          module: MODULE_NAME, method: 'handlePushTransactionCdr',
          user: req.user, action
        });
      }
      // Save
      await TransactionStorage.saveTransactionOcpiData(req.tenant, transaction.id, transaction.ocpiData);
      await Logging.logInfo({
        ...LoggingHelper.getTransactionProperties(transaction),
        tenantID: req.tenant.id,
        action, module: MODULE_NAME, method: 'handlePushTransactionCdr',
        user: req.user, actionOnUser: (transaction.user ? transaction.user : null),
        message: `CDR of Transaction ID '${transaction.id}' has been pushed successfully`,
        detailedMessages: { cdr: transaction.ocpiData.cdr }
      });
    }
    // Check OICP
    if (transaction.oicpData?.session) {
      // CDR already pushed
      if (transaction.oicpData.cdr?.SessionID) {
        throw new AppError({
          ...LoggingHelper.getTransactionProperties(transaction),
          errorCode: HTTPError.TRANSACTION_CDR_ALREADY_PUSHED,
          message: `The CDR of the transaction ID '${transaction.id}' has already been pushed`,
          module: MODULE_NAME, method: 'handlePushTransactionCdr',
          user: req.user, action
        });
      }
      // OICP: Post the CDR
      const oicpCdrSent = await OICPFacade.checkAndSendTransactionCdr(
        req.tenant, transaction, chargingStation, chargingStation.siteArea, action);
      if (!oicpCdrSent) {
        throw new AppError({
          ...LoggingHelper.getTransactionProperties(transaction),
          errorCode: HTTPError.GENERAL_ERROR,
          message: `The CDR of the Transaction ID '${transaction.id}' has not been sent`,
          module: MODULE_NAME, method: 'handlePushTransactionCdr',
          user: req.user, action
        });
      }
      // Save
      await TransactionStorage.saveTransactionOicpData(req.tenant, transaction.id, transaction.oicpData);
      await Logging.logInfo({
        ...LoggingHelper.getTransactionProperties(transaction),
        tenantID: req.tenant.id,
        user: req.user, actionOnUser: (transaction.user ?? null),
        action, module: MODULE_NAME, method: 'handlePushTransactionCdr',
        message: `CDR of Transaction ID '${transaction.id}' has been pushed successfully`,
        detailedMessages: { cdr: transaction.ocpiData.cdr }
      });
    }
    res.json(Constants.REST_RESPONSE_SUCCESS);
    next();
  }

  public static async handleDeleteTransaction(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const transactionID = TransactionValidatorRest.getInstance().validateTransactionDeleteReq(req.query).ID;
    // Delete
    const result = await TransactionService.deleteTransactions(action, req.tenant, req.user, [transactionID]);
    res.json({ ...result, ...Constants.REST_RESPONSE_SUCCESS });
    next();
  }

  public static async handleDeleteTransactions(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const transactionsIDs = TransactionValidatorRest.getInstance().validateTransactionsByIDsGetReq(req.body).transactionsIDs;
    // Delete
    const result = await TransactionService.deleteTransactions(action, req.tenant, req.user, transactionsIDs);
    res.json({ ...result, ...Constants.REST_RESPONSE_SUCCESS });
    next();
  }

  public static async handleTransactionStart(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const remoteStartRequest = ChargingStationValidatorRest.getInstance().validateChargingStationActionTransactionStartReq(req.body);
    // Check dynamic auth
    const { chargingStation } = await TransactionService.checkAndGetChargingStationConnector(
      action, req.tenant, req.user, remoteStartRequest.chargingStationID, remoteStartRequest.args.connectorId, Action.REMOTE_START_TRANSACTION);
    // Handle the routing
    if (chargingStation.issuer) {
      // OCPP Remote Start
      await ChargingStationService.handleOcppAction(
        ServerAction.CHARGING_STATION_REMOTE_START_TRANSACTION, req, res, next);
    } else {
      // OCPI Remote Start
      await ChargingStationService.handleOcpiAction(
        ServerAction.OCPI_EMSP_START_SESSION, req, res, next);
    }
  }

  public static async handleTransactionStop(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const transactionID = TransactionValidatorRest.getInstance().validateTransactionStopReq(req.body).ID;
    // Get data
    const { transaction, chargingStation, connector } =
      await TransactionService.checkAndGetTransactionChargingStationConnector(action, req.tenant, req.user, transactionID, Action.REMOTE_STOP_TRANSACTION);
    req.body.chargingStationID = transaction.chargeBoxID;
    req.body.args = { transactionId: transaction.id };
    // Handle the routing
    if (chargingStation.issuer) {
      // OCPP Remote Stop
      if (!chargingStation.inactive && connector.currentTransactionID === transaction.id) {
        await ChargingStationService.handleOcppAction(ServerAction.CHARGING_STATION_REMOTE_STOP_TRANSACTION, req, res, next);
      // Transaction Soft Stop
      } else {
        await TransactionService.transactionSoftStop(ServerAction.TRANSACTION_SOFT_STOP,
          transaction, chargingStation, connector, req, res, next);
      }
    } else {
      // eslint-disable-next-line no-lonely-if
      if (connector.currentTransactionID === transaction.id) {
        // OCPI Remote Stop
        await ChargingStationService.handleOcpiAction(ServerAction.OCPI_EMSP_STOP_SESSION, req, res, next);
      } else {
        await TransactionService.transactionSoftStop(ServerAction.TRANSACTION_SOFT_STOP,
          transaction, chargingStation, connector, req, res, next);
      }
    }
  }

  public static async handleTransactionSoftStop(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const transactionID = TransactionValidatorRest.getInstance().validateTransactionStopReq(req.body).ID;
    // Get data
    const { transaction, chargingStation, connector } =
      await TransactionService.checkAndGetTransactionChargingStationConnector(action, req.tenant, req.user, transactionID, Action.REMOTE_STOP_TRANSACTION);
    // Soft Stop
    await TransactionService.transactionSoftStop(action, transaction, chargingStation, connector, req, res, next);
  }

  public static async handleGetTransactionConsumption(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionConsumptionsGetReq(req.query);
    // Check dynamic auth
    const transaction = await UtilsService.checkAndGetTransactionAuthorization(req.tenant, req.user, filteredRequest.TransactionId, Action.READ,
      action, null, { withTag: filteredRequest.WithTag, withCar: filteredRequest.WithCar, withUser: filteredRequest.WithUser }, true);
    // Check Dates
    if (filteredRequest.StartDateTime && filteredRequest.EndDateTime &&
      moment(filteredRequest.StartDateTime).isAfter(moment(filteredRequest.EndDateTime))) {
      throw new AppError({
        ...LoggingHelper.getTransactionProperties(transaction),
        errorCode: HTTPError.GENERAL_ERROR,
        message: `The requested start date '${new Date(filteredRequest.StartDateTime).toISOString()}' is after the requested end date '${new Date(filteredRequest.StartDateTime).toISOString()}' `,
        module: MODULE_NAME, method: 'handleGetConsumptionFromTransaction',
        user: req.user, action
      });
    }
    // Check consumption dynamic auth
    const authorizations = await AuthorizationService.checkAndGetConsumptionsAuthorizations(req.tenant, req.user, Action.LIST);
    let consumptions: Consumption[];
    if (filteredRequest.LoadAllConsumptions) {
      const consumptionsMDB = await ConsumptionStorage.getTransactionConsumptions(
        req.tenant,
        {
          transactionId: transaction.id
        },
        Constants.DB_PARAMS_MAX_LIMIT,
        authorizations.projectFields
      );
      consumptions = consumptionsMDB.result;
    } else {
      consumptions = (await ConsumptionStorage.getOptimizedTransactionConsumptions(
        req.tenant,
        {
          transactionId: transaction.id
        },
        authorizations.projectFields
      )).result;
    }
    // Assign
    transaction.values = consumptions;
    // Return the result
    res.json(transaction);
    next();
  }

  public static async handleGetTransactionConsumptionForAdvenir(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.OCPI,
      Action.READ, Entity.TRANSACTION, MODULE_NAME, 'handleGetTransactionConsumptionForAdvenir');
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionConsumptionsAdvenirGetReq(req.query);
    // Get dynamic auth
    const transaction = await UtilsService.checkAndGetTransactionAuthorization(req.tenant, req.user, filteredRequest.TransactionId, Action.GET_ADVENIR_CONSUMPTION,
      action, null, { withChargingStation: true }, true);
    try {
      const ocpiClient = await OCPIClientFactory.getAvailableOcpiClient(req.tenant, OCPIRole.CPO) as CpoOCPIClient;
      if (!ocpiClient) {
        throw new AppError({
          errorCode: HTTPError.GENERAL_ERROR,
          message: 'OCPI component requires at least one CPO endpoint to generate Advenir consumption data',
          module: MODULE_NAME, method: 'handleGetTransactionConsumptionForAdvenir',
          user: req.user, action
        });
      }
      // Build EvseID
      const evseID = RoamingUtils.buildEvseID(ocpiClient.getLocalCountryCode(action), ocpiClient.getLocalPartyID(action), transaction.chargeBox, transaction.connectorId);
      // Check consumption dynamic auth
      const authorizations = await AuthorizationService.checkAndGetConsumptionsAuthorizations(req.tenant, req.user, Action.GET_ADVENIR_CONSUMPTION, null, true);
      // Get Consumption
      const consumptions = await ConsumptionStorage.getOptimizedTransactionConsumptions(req.tenant,
        { transactionId: transaction.id },
        // ACHTUNG - endedAt must be part of the projection to properly sort the collection result
        authorizations.projectFields
      );
      // Convert consumptions to the ADVENIR format
      const advenirValues: AdvenirConsumptionData[] = consumptions.result.map(
        (consumption) => {
          // Unix epoch format expected
          const timestamp = Utils.createDecimal(consumption.startedAt.getTime()).div(1000).toNumber();
          return {
            timestamp,
            value: consumption.cumulatedConsumptionWh
          };
        }
      );
      // Add Advenir user Id if exists
      const userID = filteredRequest.AdvenirUserId ?? '<put-here-the-advenir-cpo-id>';
      // Prepare ADVENIR payload
      const transactionID = `${transaction.id}`;
      const transactionData: AdvenirTransactionData = {
        [transactionID]:
          advenirValues
      };
      const evseData: AdvenirEvseData = {
        [evseID]: transactionData
      };
      const advenirPayload: AdvenirPayload = {
        [userID]: evseData
      };
      res.json(advenirPayload);
    } catch (error) {
      await Logging.logActionExceptionMessageAndSendResponse(action, error, req, res, next);
    }
  }

  public static async handleGetTransaction(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionGetReq(req.query);
    // Check dynamic auth
    const transaction = await UtilsService.checkAndGetTransactionAuthorization(req.tenant, req.user, filteredRequest.ID, Action.READ,
      action, null, { withTag: filteredRequest.WithTag, withCar: filteredRequest.WithCar, withUser: filteredRequest.WithUser }, true);
    res.json(transaction);
    next();
  }

  public static async handleGetChargingStationTransactions(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsGetReq(req.query);
    // Get Transactions
    const transactions = await TransactionService.getTransactions(req, filteredRequest, Action.GET_CHARGING_STATION_TRANSACTIONS);
    res.json(transactions);
    next();
  }

  public static async handleGetTransactionYears(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Get Transactions
    const transactionsYears = await TransactionStorage.getTransactionYears(req.tenant);
    const result: any = {};
    if (transactionsYears) {
      result.years = [];
      result.years.push(new Date().getFullYear());
    }
    res.json(transactionsYears);
    next();
  }

  public static async handleGetTransactionsActive(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    req.query.Status = TransactionStatus.ACTIVE;
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsGetReq(req.query);
    // Get Transactions
    const transactions = await TransactionService.getTransactions(req, filteredRequest, Action.GET_ACTIVE_TRANSACTION);
    res.json(transactions);
    next();
  }

  public static async handleGetTransactionsCompleted(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Get transaction
    req.query.Status = TransactionStatus.COMPLETED;
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsGetReq(req.query);
    // Get Transactions
    const transactions = await TransactionService.getTransactions(req, filteredRequest, Action.GET_COMPLETED_TRANSACTION);
    res.json(transactions);
    next();
  }

  public static async handleGetTransactionsToRefund(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.REFUND,
      Action.LIST, Entity.TRANSACTION, MODULE_NAME, 'handleGetTransactionsToRefund');
    // Set filter
    req.query.issuer = 'true';
    req.query.Status = TransactionStatus.COMPLETED;
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsGetReq(req.query);
    // Get Transactions
    const transactions = await TransactionService.getTransactions(req, filteredRequest, Action.GET_REFUNDABLE_TRANSACTION);
    res.json(transactions);
    next();
  }

  public static async handleGetRefundReports(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if component is active
    UtilsService.assertComponentIsActiveFromToken(req.user, TenantComponents.REFUND,
      Action.LIST, Entity.TRANSACTION, MODULE_NAME, 'handleGetRefundReports');
    // Filter request
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsGetReq(req.query);
    // Check dyna;ic auth
    const authorizations = await AuthorizationService.checkAndGetTransactionsAuthorizations(req.tenant, req.user, Action.GET_REFUND_REPORT, filteredRequest);
    // Get Reports
    const reports = await TransactionStorage.getRefundReports(
      req.tenant,
      {
        siteIDs: (filteredRequest.SiteID ? filteredRequest.SiteID.split('|') : null),
        siteAreaIDs: filteredRequest.SiteAreaID ? filteredRequest.SiteAreaID.split('|') : null,
        ...authorizations.filters
      },
      {
        limit: filteredRequest.Limit,
        skip: filteredRequest.Skip,
        sort: filteredRequest.SortFields,
        onlyRecordCount: filteredRequest.OnlyRecordCount
      },
      authorizations.projectFields);
    // Add Auth flags
    await AuthorizationService.addRefundReportsAuthorizations(
      req.tenant, req.user, reports.result, authorizations);
    res.json(reports);
    next();
  }

  public static async handleExportTransactions(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Force params
    req.query.Limit = Constants.EXPORT_PAGE_SIZE.toString();
    req.query.Status = TransactionStatus.COMPLETED;
    req.query.WithTag = 'true';
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsGetReq(req.query);
    // Export
    await UtilsService.exportToCSV(req, res, 'exported-sessions.csv', filteredRequest,
      TransactionService.getTransactions.bind(this, req, filteredRequest, Action.EXPORT_COMPLETED_TRANSACTION),
      TransactionService.convertToCSV.bind(this));
  }

  public static async handleExportPdfTransactions(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Force params
    req.query.Limit = Constants.EXPORT_PAGE_SIZE.toString();
    req.query.Status = TransactionStatus.COMPLETED;
    req.query.WithTag = 'true';
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsGetReq(req.query);
     await UtilsService.exportToPDFTransaction(req, res, 'exported-sessions.pdf', filteredRequest,  
     TransactionService.getTransactions.bind(this, req, filteredRequest, Action.EXPORT_COMPLETED_TRANSACTION),
     TransactionService.convertToPDFTransaction.bind(this));

 
  }


  public static async handleExportTransactionsToRefund(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Force params
    req.query.Limit = Constants.EXPORT_PAGE_SIZE.toString();
    req.query.Status = TransactionStatus.COMPLETED;
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsGetReq(req.query);
    // Export
    await UtilsService.exportToCSV(req, res, 'exported-refund-sessions.csv', filteredRequest,
      TransactionService.getTransactions.bind(this, req, filteredRequest, Action.GET_REFUNDABLE_TRANSACTION),
      TransactionService.convertToCSV.bind(this));
  }

  public static async handleExportTransactionOcpiCdr(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionCdrExportReq(req.query);
    // Get Transaction
    const transaction = await UtilsService.checkAndGetTransactionAuthorization(req.tenant, req.user, filteredRequest.ID, Action.EXPORT_OCPI_CDR, action, null, null, true);
    if (!transaction?.ocpiData) {
      throw new AppError({
        ...LoggingHelper.getTransactionProperties(transaction),
        errorCode: HTTPError.GENERAL_ERROR,
        message: `Transaction ID '${transaction.id}' does not contain roaming data`,
        module: MODULE_NAME, method: 'handleExportTransactionOcpiCdr',
        user: req.user, action
      });
    }
    // Get Ocpi Data
    res.json(transaction.ocpiData.cdr);
    next();
  }

  public static async handleGetTransactionsInError(action: ServerAction, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check auth
    const authorizations = await AuthorizationService.checkAndGetTransactionsAuthorizations(req.tenant, req.user, Action.IN_ERROR);
    // Filter
    const filteredRequest = TransactionValidatorRest.getInstance().validateTransactionsInErrorGetReq(req.query);
    // Site Area
    const transactions = await TransactionStorage.getTransactionsInError(req.tenant,
      {
        search: filteredRequest.Search,
        issuer: true,
        errorType: filteredRequest.ErrorType ? filteredRequest.ErrorType.split('|') : UtilsService.getTransactionInErrorTypes(req.user),
        endDateTime: filteredRequest.EndDateTime,
        startDateTime: filteredRequest.StartDateTime,
        chargingStationIDs: filteredRequest.ChargingStationID ? filteredRequest.ChargingStationID.split('|') : null,
        siteAreaIDs: filteredRequest.SiteAreaID ? filteredRequest.SiteAreaID.split('|') : null,
        siteIDs: await Authorizations.getAuthorizedSiteAdminIDs(req.tenant, req.user, filteredRequest.SiteID ? filteredRequest.SiteID.split('|') : null),
        userIDs: filteredRequest.UserID ? filteredRequest.UserID.split('|') : null,
        connectorIDs: filteredRequest.ConnectorID ? filteredRequest.ConnectorID.split('|').map((connectorID) => Utils.convertToInt(connectorID)) : null,
        ...authorizations.filters
      },
      {
        limit: filteredRequest.Limit,
        skip: filteredRequest.Skip,
        sort: UtilsService.httpSortFieldsToMongoDB(filteredRequest.SortFields)
      },
      authorizations.projectFields
    );
    // Assign projected fields
    if (authorizations.projectFields) {
      transactions.projectFields = authorizations.projectFields;
    }
    // Add Auth flags
    await AuthorizationService.addTransactionsInErrorAuthorizations(req.tenant, req.user, transactions, authorizations);

    res.json(transactions);
    next();
  }

  private static convertToCSV(req: Request, transactions: Transaction[], writeHeader = true): string {
    let headers = null;
    // Header
    if (writeHeader) {
      const headerArray = [
        'id',
        'chargingStationID',
        'connectorID',
        'companyName',
        'siteName',
        'siteAreaName',
        'userID',
        'user',
        'tagID',
        'visualTagID',
        'tagDescription',
        'timezone',
        'startDate',
        'startTime',
        'endDate',
        'endTime',
        'totalConsumptionkWh',
        'totalDurationMins',
        'totalInactivityMins',
        'price',
        'priceUnit'
      ];
      headers = headerArray.join(Constants.CSV_SEPARATOR);
    }
    // Content
    const rows = transactions.map((transaction) => {
      const row = [
        transaction.id,
        transaction.chargeBoxID,
        transaction.connectorId,
        transaction.company?.name,
        transaction.site?.name,
        transaction.siteArea?.name,
        transaction.user ? transaction.user.id : '',
        transaction.user ? Utils.buildUserFullName(transaction.user, false) : '',
        transaction.tagID,
        transaction.tag?.visualID,
        transaction.tag?.description || '',
        transaction.timezone || 'N/A (UTC by default)',
        (transaction.timezone ? moment(transaction.timestamp).tz(transaction.timezone) : moment.utc(transaction.timestamp)).format('YYYY-MM-DD'),
        (transaction.timezone ? moment(transaction.timestamp).tz(transaction.timezone) : moment.utc(transaction.timestamp)).format('HH:mm:ss'),
        (transaction.stop ? (transaction.timezone ? moment(transaction.stop.timestamp).tz(transaction.timezone) : moment.utc(transaction.stop.timestamp)).format('YYYY-MM-DD') : ''),
        (transaction.stop ? (transaction.timezone ? moment(transaction.stop.timestamp).tz(transaction.timezone) : moment.utc(transaction.stop.timestamp)).format('HH:mm:ss') : ''),
        transaction.stop ?
          (transaction.stop.totalConsumptionWh ? Utils.truncTo(Utils.createDecimal(transaction.stop.totalConsumptionWh).div(1000).toNumber(), 2) : 0) : '',
        transaction.stop ?
          (transaction.stop.totalDurationSecs ? Utils.truncTo(Utils.createDecimal(transaction.stop.totalDurationSecs).div(60).toNumber(), 2) : 0) : '',
        transaction.stop ?
          (transaction.stop.totalInactivitySecs ? Utils.truncTo(Utils.createDecimal(transaction.stop.totalInactivitySecs).div(60).toNumber(), 2) : 0) : '',
        transaction.stop ? transaction.stop.roundedPrice : '',
        transaction.stop ? transaction.stop.priceUnit : ''
      ].map((value) => Utils.escapeCsvValue(value));
      return row;
    }).join(Constants.CR_LF);
    console.log()
    return Utils.isNullOrUndefined(headers) ? Constants.CR_LF + rows : [headers, rows].join(Constants.CR_LF);
  }

  private static convertToPDFTransaction(req: Request, pdfDocument: PDFKit.PDFDocument, transactions: Transaction[]) {
  
// Create a document
    const fs = require('fs');

    function generateHr(pdfDocument, y) {
      pdfDocument.strokeColor("#aaaaaa")
    .lineWidth(1)
    .moveTo(50, y)
    .lineTo(550, y)
    .stroke();
    }

    function formatDate(date) {
      const day = date.getDate();
      const month = date.getMonth() + 1;
      const year = date.getFullYear();
    
      return year + "/" + month + "/" + day;
    }

    function generateTableRow(
      pdfDocument,
      y,
      date,
      borneId,
      userId,
      consumption,
      unitCost,
      cost
    ) {
      pdfDocument
        .fontSize(10)
        .text(date, 50, y)
        .text(borneId, 120, y)
        .text(userId, 200, y)
        .text(consumption, 330, y, {width:80, align: 'right' })
        .text(unitCost, 410, y, {width:80, align: 'right' })
        .text(cost, 0, y, { align: 'right' });
    }
    const imageB64 ="data:image/png;base64,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";    

    const invoiceTableTop = 315;

    pdfDocument.font("Helvetica-Bold");
    generateTableRow(
      pdfDocument,
      invoiceTableTop,
      "Date",
      "ID Session",
      "ID Borne",
      "Consommation ",
      "Coût",
      "Coût"
    );
    generateTableRow(
      pdfDocument,
      invoiceTableTop + 10,
      "de session",
      "",
      "",
      "(kWh)",
      "Unitaire",
      "Session"
    );
    generateHr(pdfDocument, invoiceTableTop + 23);
    pdfDocument.font("Helvetica");

    let i = 0;
    let timeTotal = 0;
    let consumptionTotal = 0;
    let costTotal = 0;
    let companyName;
    let companyAddress;
    let priceUnit;
    let unitCost;
    let transactionCost;
    let transactionConsumption;
    let transactionDate;
    let userId;
    let borneId;
    let sessionId;
    let userName;

    for (const transaction of transactions) {
      companyName = transaction.company?.name
      priceUnit  = transaction.stop.priceUnit;
      costTotal = costTotal + (transaction.stop.roundedPrice ? transaction.stop.roundedPrice : 0);
      consumptionTotal = consumptionTotal +  (transaction.stop ?(transaction.stop.totalConsumptionWh ? Utils.truncTo(Utils.createDecimal(transaction.stop.totalConsumptionWh).div(1000).toNumber(), 2) : 0) : 0);
      transactionDate = (transaction.timezone ? moment(transaction.timestamp).tz(transaction.timezone) : moment.utc(transaction.timestamp)).format('YYYY-MM-DD') ;
      userId = transaction.user ? transaction.user.id : '';
      borneId = transaction.chargeBoxID;
      sessionId = transaction.id;
      userName = transaction.user ? Utils.buildUserFullName(transaction.user, false) : '';

      transactionConsumption = transaction.stop ?(transaction.stop.totalConsumptionWh ? Utils.truncTo(Utils.createDecimal(transaction.stop.totalConsumptionWh).div(1000).toNumber(), 2) : 0) : '';
      transactionCost = transaction.stop ? transaction.stop.roundedPrice : '';
      unitCost = (transactionCost / transactionConsumption).toFixed(2);

      const position = invoiceTableTop + (i + 1) * 30;
      generateTableRow(
        pdfDocument,
        position,
        transactionDate,
        sessionId,
        borneId,
        transactionConsumption,
        unitCost,
        transactionCost,
      );
  
      generateHr(pdfDocument, position + 20);
      i++
    }

    const subtotalPosition = invoiceTableTop + (i + 1) * 30;
    pdfDocument.font("Helvetica-Bold");
    generateTableRow(
      pdfDocument,
      subtotalPosition ,
      "",
      "",
      "",
      "",
      "Total :",
      costTotal +" "+priceUnit
    );

    pdfDocument
    .fillColor("#444444")
    .fontSize(20)
    .text("Note de frais - Session de recharge", 50, 160);

  generateHr(pdfDocument, 185);

  const customerInformationTop = 200;

  pdfDocument
    .fontSize(10)
    .text("Utilisateur:", 50, customerInformationTop)
    .font("Helvetica-Bold")
    .text(userName, 175, customerInformationTop)
    .font("Helvetica")
    .text("Entreprise :", 50, customerInformationTop + 15)
    .text(companyName, 175, customerInformationTop + 15)
    .text("Date:", 50, customerInformationTop + 30)
    .text(formatDate(new Date()), 175, customerInformationTop + 30).font("Helvetica-Bold")
    .text("Coût Total : " + costTotal.toString() + " " + priceUnit, 50, customerInformationTop + 45)
    .text("Coût Unitaire moyen : " + ((costTotal / consumptionTotal).toFixed(2)).toString() + " " + priceUnit +"/kWh",
      175,
      customerInformationTop + 45
    )

    .font("Helvetica-Bold")
    .text("ID : " + userId , 300, customerInformationTop)
    .font("Helvetica")
    .text(" ", 300, customerInformationTop + 15)
    .text(
      " ",
      300,
      customerInformationTop + 30
    );

    generateHr(pdfDocument, 267);


    pdfDocument.image(imageB64, 50, 45, { width: 80 })
    .fillColor('#444444')
		.fontSize(20)
		.fontSize(10);

   

}

  private static async deleteTransactions(action: ServerAction, tenant: Tenant, loggedUser: UserToken, transactionsIDs: number[]): Promise<ActionsResponse> {
    const transactionsIDsToDelete = [];
    const result: ActionsResponse = {
      inSuccess: 0,
      inError: 0
    };
    // Check dynamic auth for each transaction before initiating delete operations
    for (const transactionID of transactionsIDs) {
      await UtilsService.checkAndGetTransactionAuthorization(tenant, loggedUser, transactionID, Action.DELETE, action);
    }
    const refundConnector = await RefundFactory.getRefundImpl(tenant);
    const billingImpl = await BillingFactory.getBillingImpl(tenant);
    // Check if transaction can be deleted
    for (const transactionID of transactionsIDs) {
      // Get transaction
      const transaction = await UtilsService.checkAndGetTransactionAuthorization(tenant, loggedUser, transactionID, Action.DELETE, action);
      // Transaction refunded
      if (refundConnector && !refundConnector.canBeDeleted(transaction)) {
        result.inError++;
        await Logging.logError({
          ...LoggingHelper.getTransactionProperties(transaction),
          tenantID: loggedUser.tenantID,
          user: loggedUser,
          action, module: MODULE_NAME, method: 'handleDeleteTransactions',
          message: `Transaction ID '${transaction.id}' has been refunded and cannot be deleted`,
          detailedMessages: { transaction }
        });
        continue;
      }
      // Transaction billed
      if (billingImpl && transaction.billingData?.stop?.status === BillingStatus.BILLED) {
        result.inError++;
        await Logging.logError({
          ...LoggingHelper.getTransactionProperties(transaction),
          tenantID: loggedUser.tenantID,
          user: loggedUser,
          action, module: MODULE_NAME, method: 'handleDeleteTransactions',
          message: `Transaction ID '${transaction.id}' has been billed and cannot be deleted`,
          detailedMessages: { transaction }
        });
        continue;
      }
      // Transaction in progress
      if (!transaction.stop) {
        if (!transaction.chargeBox) {
          transactionsIDsToDelete.push(transaction.id);
        } else {
          // Check connector
          const foundConnector = Utils.getConnectorFromID(transaction.chargeBox, transaction.connectorId);
          if (foundConnector && transaction.id === foundConnector.currentTransactionID) {
            OCPPUtils.clearChargingStationConnectorRuntimeData(transaction.chargeBox, transaction.connectorId);
            await ChargingStationStorage.saveChargingStationConnectors(tenant,
              transaction.chargeBox.id, transaction.chargeBox.connectors);
          }
          // To Delete
          transactionsIDsToDelete.push(transaction.id);
        }
        continue;
      }
      transactionsIDsToDelete.push(transaction.id);
    }
    // Delete only valid transactions, and log the ones we skipped / failed to delete
    result.inSuccess = await TransactionStorage.deleteTransactions(tenant, transactionsIDsToDelete);
    await Logging.logActionsResponse(loggedUser.tenantID,
      ServerAction.TRANSACTIONS_DELETE,
      MODULE_NAME, 'deleteTransactions', result,
      '{{inSuccess}} transaction(s) were successfully deleted',
      '{{inError}} transaction(s) failed to be deleted',
      '{{inSuccess}} transaction(s) were successfully deleted and {{inError}} failed to be deleted',
      'No transactions have been deleted', loggedUser
    );
    return result;
  }

  private static async getTransactions(req: Request, filteredRequest: HttpTransactionsGetRequest,
      authAction: Action = Action.LIST, additionalFilters: Record<string, any> = {}): Promise<DataResult<Transaction>> {
    // Get authorization filters
    const authorizations = await AuthorizationService.checkAndGetTransactionsAuthorizations(
      req.tenant, req.user, authAction, filteredRequest, false);
    if (!authorizations.authorized) {
      return Constants.DB_EMPTY_DATA_RESULT;
    }
    // Get Tag IDs from Visual IDs
    if (filteredRequest.VisualTagID) {
      const tagIDs = await TagStorage.getTags(req.tenant, { visualIDs: filteredRequest.VisualTagID.split('|') }, Constants.DB_PARAMS_MAX_LIMIT, ['id']);
      if (!Utils.isEmptyArray(tagIDs.result)) {
        filteredRequest.TagID = tagIDs.result.map((tag) => tag.id).join('|');
      }
    }
    // Get the transactions
    const transactions = await TransactionStorage.getTransactions(req.tenant,
      {
        search: filteredRequest.Search ? filteredRequest.Search : null,
        status: filteredRequest.Status,
        chargingStationIDs: filteredRequest.ChargingStationID ? filteredRequest.ChargingStationID.split('|') : null,
        issuer: Utils.objectHasProperty(filteredRequest, 'Issuer') ? filteredRequest.Issuer : null,
        userIDs: filteredRequest.UserID ? filteredRequest.UserID.split('|') : null,
        tagIDs: filteredRequest.TagID ? filteredRequest.TagID.split('|') : null,
        withTag: filteredRequest.WithTag,
        withUser: filteredRequest.WithUser,
        withChargingStation: filteredRequest.WithChargingStation,
        withCar: filteredRequest.WithCar,
        withSite: filteredRequest.WithSite,
        withCompany:filteredRequest.WithCompany,
        withSiteArea: filteredRequest.WithSiteArea,
        siteIDs: (filteredRequest.SiteID ? filteredRequest.SiteID.split('|') : null),
        siteAreaIDs: filteredRequest.SiteAreaID ? filteredRequest.SiteAreaID.split('|') : null,
        startDateTime: filteredRequest.StartDateTime ? filteredRequest.StartDateTime : null,
        endDateTime: filteredRequest.EndDateTime ? filteredRequest.EndDateTime : null,
        refundStatus: filteredRequest.RefundStatus ? filteredRequest.RefundStatus.split('|') as RefundStatus[] : null,
        minimalPrice: filteredRequest.MinimalPrice ? filteredRequest.MinimalPrice : null,
        statistics: filteredRequest.Statistics ? filteredRequest.Statistics : null,
        reportIDs: filteredRequest.ReportIDs ? filteredRequest.ReportIDs.split('|') : null,
        connectorIDs: filteredRequest.ConnectorID ? filteredRequest.ConnectorID.split('|').map((connectorID) => Utils.convertToInt(connectorID)) : null,
        inactivityStatus: filteredRequest.InactivityStatus ? filteredRequest.InactivityStatus.split('|') : null,
        ...authorizations.filters
      },
      {
        limit: filteredRequest.Limit,
        skip: filteredRequest.Skip,
        sort: UtilsService.httpSortFieldsToMongoDB(filteredRequest.SortFields),
        onlyRecordCount: filteredRequest.OnlyRecordCount,
      },
      authorizations.projectFields
    );
    // Assign projected fields
    if (authorizations.projectFields) {
      transactions.projectFields = authorizations.projectFields;
    }
    // Add Auth flags
    await AuthorizationService.addTransactionsAuthorizations(
      req.tenant, req.user, transactions, authorizations);

    return transactions;
  }

  private static async transactionSoftStop(action: ServerAction, transaction: Transaction, chargingStation: ChargingStation,
      connector: Connector, req: Request, res: Response, next: NextFunction): Promise<void> {
    // Check if already stopped
    if (transaction.stop) {
      // Clear Connector
      if (connector.currentTransactionID === transaction.id) {
        OCPPUtils.clearChargingStationConnectorRuntimeData(chargingStation, transaction.connectorId);
        await ChargingStationStorage.saveChargingStationConnectors(req.tenant, chargingStation.id, chargingStation.connectors);
      }
      await Logging.logInfo({
        ...LoggingHelper.getTransactionProperties(transaction),
        tenantID: req.tenant.id,
        user: req.user, actionOnUser: transaction.userID,
        action, module: MODULE_NAME, method: 'transactionSoftStop',
        message: `${Utils.buildConnectorInfo(transaction.connectorId, transaction.id)} Transaction has already been stopped`,
      });
    } else {
      // Transaction is still ongoing
      if (!chargingStation.inactive && connector.currentTransactionID === transaction.id) {
        throw new AppError({
          ...LoggingHelper.getTransactionProperties(transaction),
          errorCode: HTTPError.GENERAL_ERROR,
          message: `${Utils.buildConnectorInfo(transaction.connectorId, transaction.id)} Cannot soft stop an ongoing Transaction`,
          module: MODULE_NAME, method: 'transactionSoftStop',
          user: req.user, action
        });
      }
      // Stop Transaction
      try {
        await new OCPPService(Configuration.getChargingStationConfig()).softStopTransaction(
          req.tenant, transaction, chargingStation, chargingStation.siteArea);
        await Logging.logInfo({
          ...LoggingHelper.getTransactionProperties(transaction),
          tenantID: req.tenant.id,
          user: req.user, actionOnUser: transaction.userID,
          module: MODULE_NAME, method: 'transactionSoftStop',
          message: `${Utils.buildConnectorInfo(transaction.connectorId, transaction.id)} Transaction has been soft stopped successfully`,
          action, detailedMessages: { transaction }
        });
      } catch (error) {
        throw new AppError({
          ...LoggingHelper.getTransactionProperties(transaction),
          errorCode: HTTPError.GENERAL_ERROR,
          message: `${Utils.buildConnectorInfo(transaction.connectorId, transaction.id)} Transaction cannot be soft stopped`,
          module: MODULE_NAME, method: 'transactionSoftStop',
          user: req.user, action
        });
      }
    }
    res.json(Constants.REST_CHARGING_STATION_COMMAND_RESPONSE_SUCCESS);
    next();
  }

  private static async checkAndGetTransactionChargingStationConnector(action: ServerAction, tenant: Tenant, user: UserToken,
      transactionID: number, authAction: Action): Promise<{ transaction: Transaction; chargingStation: ChargingStation; connector: Connector; }> {
    // Check dynamic auth
    const transaction = await UtilsService.checkAndGetTransactionAuthorization(tenant, user, transactionID, authAction, action);
    const { chargingStation, connector } = await TransactionService.checkAndGetChargingStationConnector(action, tenant, user,
      transaction.chargeBoxID, transaction.connectorId, authAction);
    return { transaction, chargingStation, connector };
  }

  private static async checkAndGetChargingStationConnector(action: ServerAction, tenant: Tenant, user: UserToken,
      chargingStationID: string, connectorID: number, authAction: Action): Promise<{ chargingStation: ChargingStation; connector: Connector; }> {
    // Get the Charging Station
    const chargingStation = await UtilsService.checkAndGetChargingStationAuthorization(tenant, user, chargingStationID, authAction, action, null, { withSiteArea: true });
    // Check connector
    const connector = Utils.getConnectorFromID(chargingStation, connectorID);
    if (!connector) {
      throw new AppError({
        ...LoggingHelper.getChargingStationProperties(chargingStation),
        errorCode: HTTPError.GENERAL_ERROR,
        message: `${Utils.buildConnectorInfo(connectorID)} The Connector ID has not been found`,
        user, action, module: MODULE_NAME, method: 'checkAndGetChargingStationConnector',
      });
    }
    return { chargingStation, connector };
  }
}
